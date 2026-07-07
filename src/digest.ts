import { blocks, messageText, type Rec, readRecords, resultText } from "./parse.js";

/** Tool display name; single source of truth for the rename agent. */
export const TOOL = "unforget";

const CHAR_CAP = 9_500;
// Require an actual test runner: bare "test"/"spec" also match paths like `src/test/x`.
const TEST_RE =
  /\b(pytest|jest|vitest|mocha|rspec|phpunit|ctest|(bun|go|cargo|npm|pnpm|yarn|deno)\s+(run\s+)?test|npm\s+t\b|make\s+test|(python3?|node)(\s+\S+)?\s+\S*\btests?\b)/i;
const CONSTRAINT_RE = /(don'?t|do not|never|must not|avoid|only use|always)\b/i;
// Low-signal "keep going" nudges — a poor active task if a real ask exists.
const CONTINUATION_RE =
  /^(continue|go on|go ahead|proceed|keep going|yes|yep|ok(ay)?|sure|next|do it|please continue)\b/i;
// Below this many chars a message is chat, not a task statement.
const SUBSTANTIAL = 60;
// is_error text meaning "never ran" (declined/blocked), not "ran and failed".
const REJECTED_RE =
  /tool use was rejected|doesn'?t want to proceed|permission to use|hook (denied|error)|requested permissions/i;
// Scratch/meta locations that are not project work — never "in-flight edits".
const SCRATCH_RE = /^\/(private\/)?tmp\/|\/\.claude\//;
// Search/list commands where nonzero exit usually means "no match", not "broken".
const SEARCH_RE =
  /^\s*(cd\s+[^;&|]+\s*(;|&&)\s*)?(rtk\s+proxy\s+)?(grep|rg|find|ls|git\s+grep|fd)\b/;

export interface Digest {
  activeTask: string | null;
  edits: { path: string; note: string }[];
  commands: { command: string; status: "ran" | "failed" }[];
  test: { command: string; status: "passing" | "failing" } | null;
  deadEnds: string[];
  constraints: string[];
  nextStep: string | null;
  droppedCount: number;
}

/** Records dropped at the nth-from-last compact boundary, windowed from the prior boundary; null if none. */
export function splitAtBoundary(
  records: Rec[],
  nthFromLast = 1,
): { dropped: Rec[]; droppedCount: number; summary: string } | null {
  const boundaryIdxs: number[] = [];
  for (let i = 0; i < records.length; i++) {
    if (records[i]?.type === "system" && records[i]?.subtype === "compact_boundary") {
      boundaryIdxs.push(i);
    }
  }
  if (boundaryIdxs.length < nthFromLast) return null;
  const pos = boundaryIdxs.length - nthFromLast;
  const idx = boundaryIdxs[pos];
  if (idx === undefined) return null;
  const start = pos > 0 ? (boundaryIdxs[pos - 1] ?? -1) + 1 : 0;

  const meta = records[idx]?.compactMetadata?.preservedMessages ?? {};
  const survived = new Set<string>(
    Array.isArray(meta.allUuids) ? meta.allUuids : Array.isArray(meta.uuids) ? meta.uuids : [],
  );

  const dropped: Rec[] = [];
  for (let i = start; i < idx; i++) {
    const r = records[i];
    if (r?.isMeta) continue;
    if (r?.isSidechain) continue; // subagent side-channel is out of scope
    if (typeof r?.uuid === "string" && survived.has(r.uuid)) continue;
    dropped.push(r);
  }

  // summary is read as an exclusion filter only, never as a content source (invariant 5).
  let summary = "";
  for (let i = idx + 1; i < Math.min(idx + 5, records.length); i++) {
    if (records[i]?.isCompactSummary === true) {
      summary = messageText(records[i]);
      break;
    }
  }
  return { dropped, droppedCount: dropped.length, summary };
}

/** Records after the last on-disk boundary (whole file if none) — the just-compacted window at
 * hook time, since the new boundary is flushed only AFTER hooks run (hook-contract.md). */
export function tailAfterLastBoundary(records: Rec[]): Rec[] {
  const last = records.findLastIndex(
    (r) => r?.type === "system" && r?.subtype === "compact_boundary",
  );
  return records.slice(last + 1).filter((r) => !r?.isMeta && !r?.isSidechain);
}

function trunc(s: string, n: number): string {
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length <= n ? clean : `${clean.slice(0, n - 1)}...`;
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Substantive user message: skips meta and command-like text ("<...>", "/cmd"). */
function isSubstantiveUser(rec: Rec): boolean {
  if (rec?.type !== "user") return false;
  if (rec?.isMeta || rec?.isCompactSummary) return false;
  const t = messageText(rec).trim();
  return t !== "" && !t.startsWith("<") && !t.startsWith("/");
}

/** Fraction of the first 120 tokens reading as pasted output (digits/brackets/no-letters), not prose. */
function pasteRatio(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).slice(0, 120);
  if (words.length === 0) return 1;
  const weird = words.filter(
    (w) => /\d/.test(w) || !/[a-zA-Z]/.test(w) || /[(){}[\]<>|=]/.test(w),
  ).length;
  return weird / words.length;
}

/** A user message that reads like a real ask — not chat filler, notifications, or pasted output. */
function isTaskAsk(text: string): boolean {
  const s = text.trim();
  if (/^\[request interrupted/i.test(s)) return false;
  if (s.includes("<teammate-message")) return false; // cross-session notification, not an ask
  if (CONTINUATION_RE.test(s) && s.length < SUBSTANTIAL) return false;
  if (s.split(/\s+/).length < 5) return false;
  // columnar output: 3+-space runs on 2+ lines never occur in typed prose.
  if (s.split("\n").filter((l) => /\S {3,}\S/.test(l)).length >= 2) return false;
  return pasteRatio(s) < 0.3;
}

// pasted status recap (numbered/bulleted lines, header, or leading **bold:** label), demoted vs a real ask.
function looksLikeReport(s: string): boolean {
  if (s.split("\n").filter((l) => /^\s*(\d+[.)]|[-*])\s/.test(l)).length >= 2) return true;
  if (/^#{1,6}\s/m.test(s)) return true;
  return /^\s*\*\*[^*]+\*\*:/.test(s);
}

type Ev = { kind: "edit"; file: string } | { kind: "fail" };

export function extract(dropped: Rec[]): Digest {
  const asks: string[] = [];
  let activeTaskFallback: string | null = null; // last user msg, even a "continue" nudge
  let nextStep: string | null = null;

  const editOrder: string[] = [];
  const editCount = new Map<string, number>();
  const wrote = new Set<string>();

  // Bash command by tool_use id, to match a later tool_result.
  const bashById = new Map<string, string>();
  const commands: { command: string; status: "ran" | "failed" }[] = [];
  let test: Digest["test"] = null;

  const failGroups = new Map<string, { count: number; lastError: string; sample: string }>();

  const timeline: Ev[] = [];

  const constraints: string[] = [];
  const seenConstraint = new Set<string>();

  for (const rec of dropped) {
    if (isSubstantiveUser(rec)) {
      const text = messageText(rec);
      activeTaskFallback = text;
      if (isTaskAsk(text)) {
        asks.push(text);
        // constraints only from real asks: pasted policy/teammate text is full of stray "never/don't".
        for (const s of sentences(text)) {
          if (!CONSTRAINT_RE.test(s)) continue;
          const c = trunc(s, 120);
          if (seenConstraint.has(c.toLowerCase())) continue;
          seenConstraint.add(c.toLowerCase());
          if (constraints.length < 5) constraints.push(c);
        }
      }
    }

    for (const b of blocks(rec)) {
      if (b?.type === "text" && rec?.type === "assistant" && typeof b.text === "string") {
        if (b.text.trim() !== "") nextStep = b.text; // last assistant text wins
      }
      if (b?.type === "tool_use") {
        const input = b.input ?? {};
        if (
          (b.name === "Edit" || b.name === "Write") &&
          typeof input.file_path === "string" &&
          !SCRATCH_RE.test(input.file_path)
        ) {
          const p = input.file_path;
          if (!editCount.has(p)) editOrder.push(p);
          editCount.set(p, (editCount.get(p) ?? 0) + (b.name === "Edit" ? 1 : 0));
          if (b.name === "Write") wrote.add(p);
          timeline.push({ kind: "edit", file: p });
        }
        if (b.name === "Bash" && typeof input.command === "string" && typeof b.id === "string") {
          bashById.set(b.id, input.command);
        }
      }
      if (b?.type === "tool_result" && typeof b.tool_use_id === "string") {
        const cmd = bashById.get(b.tool_use_id);
        if (cmd === undefined) continue;
        // rejected/blocked commands set is_error but never ran — not failures.
        if (b.is_error === true && REJECTED_RE.test(resultText(b))) continue;
        const err =
          resultText(b)
            .split("\n")
            .find((l) => l.trim() !== "") ?? "";
        // search/list nonzero exit with no real error text is "no match", not a failure.
        const noMatch =
          SEARCH_RE.test(cmd) && (err === "" || /^exit code \d+\s*$/i.test(err.trim()));
        const failed = b.is_error === true && !noMatch;
        commands.push({ command: cmd, status: failed ? "failed" : "ran" });
        // `-e` inline scripts false-match TEST_RE on the word "test" in their source.
        const testMatch = /\s-e\s/.test(cmd) ? null : TEST_RE.exec(cmd);
        if (testMatch) {
          // slice from the matched runner so `cd …; bun test x` renders as `bun test x`.
          test = { command: cmd.slice(testMatch.index), status: failed ? "failing" : "passing" };
        }
        if (failed) {
          timeline.push({ kind: "fail" });
          const prefix = cmd.replace(/\s+/g, " ").trim().slice(0, 40);
          const g = failGroups.get(prefix) ?? { count: 0, lastError: "", sample: cmd };
          g.count += 1;
          if (err) g.lastError = err;
          failGroups.set(prefix, g);
        }
      }
    }
  }

  const edits = editOrder.map((path) => {
    const n = editCount.get(path) ?? 0;
    const nEdits = `${n} edit${n === 1 ? "" : "s"}`;
    const note = wrote.has(path) ? (n > 0 ? `written, ${nEdits}` : "written") : nEdits;
    return { path, note };
  });

  const deadEnds: string[] = [];
  for (const g of failGroups.values()) {
    if (g.count < 2) continue;
    const reason = g.lastError ? ` (reason: ${trunc(g.lastError, 120)})` : "";
    deadEnds.push(`tried \`${trunc(g.sample, 60)}\` — failed ${g.count}x${reason}`);
  }
  // naive: edit A, a failure, then a switch away; phrased descriptively, not "abandoned".
  const abandoned = detectAbandoned(timeline);
  for (const a of abandoned) {
    const line = `edited \`${a}\`, then a command failed, then switched files — possibly unfinished`;
    if (deadEnds.length < 6) deadEnds.push(line);
  }

  // demote recaps, then most-recent substantial ask; fallback longest ask, then any last user msg.
  const nonReport = asks.filter((a) => !looksLikeReport(a));
  const pool = nonReport.length > 0 ? nonReport : asks;
  let activeTask = pool.findLast((a) => a.trim().length >= SUBSTANTIAL) ?? null;
  activeTask ??= pool.reduce<string | null>((a, b) => (a && a.length >= b.length ? a : b), null);

  return {
    activeTask: activeTask ?? activeTaskFallback,
    edits,
    commands,
    test,
    deadEnds,
    constraints,
    nextStep,
    droppedCount: dropped.length,
  };
}

function detectAbandoned(timeline: Ev[]): string[] {
  const lastEditIdx = new Map<string, number>();
  timeline.forEach((e, i) => {
    if (e.kind === "edit" && e.file) lastEditIdx.set(e.file, i);
  });
  const out: string[] = [];
  for (const [file, idx] of lastEditIdx) {
    // after A's last edit: a failure, then a different file edited = switched away.
    let sawFail = false;
    for (let i = idx + 1; i < timeline.length; i++) {
      const e = timeline[i];
      if (e?.kind === "fail") sawFail = true;
      if (e?.kind === "edit" && e.file !== file) {
        if (sawFail && !out.includes(file)) out.push(file);
        break;
      }
      if (e?.kind === "edit" && e.file === file) break; // returned to A → not abandoned
    }
  }
  return out;
}

interface Section {
  title: string;
  single?: string | null;
  items?: string[];
}

function assemble(sections: Section[], droppedCount: number): string {
  const lines: string[] = [
    "## Working state restored (lost in compaction)",
    "",
    "_Treat this as current: resume the active task; don't re-read these files or re-run these commands just to rediscover their state._",
    "",
  ];
  for (const s of sections) {
    if (s.single) {
      lines.push(`**${s.title}:** ${s.single}`, "");
    } else if (s.items && s.items.length > 0) {
      lines.push(`**${s.title}:**`);
      for (const it of s.items) lines.push(`- ${it}`);
      lines.push("");
    }
  }
  lines.push(`_(recovered by ${TOOL} from ${droppedCount} dropped messages)_`);
  return lines.join("\n");
}

/** Failures plus the test outcome; successful commands stay in the JSON but out of the render. */
function commandItems(d: Digest): string[] {
  const failed = d.commands.filter((c) => c.status === "failed");
  const items = failed.map((c) => `failed \`${trunc(c.command, 100)}\``);
  if (d.test) items.push(`test: \`${trunc(d.test.command, 80)}\` — ${d.test.status}`);
  return items;
}

/** Markdown digest. Empty sections are omitted; output is hard-capped, trimming oldest items first. */
export function render(d: Digest): string {
  const sections: Section[] = [
    { title: "Active task", single: d.activeTask ? trunc(d.activeTask, 400) : null },
    { title: "In-flight edits", items: d.edits.map((e) => `\`${e.path}\` (${e.note})`) },
    { title: "Commands & outcomes", items: commandItems(d) },
    { title: "Dead-ends", items: d.deadEnds },
    { title: "Constraints", items: d.constraints },
    {
      title: "Next step",
      single: d.nextStep ? trunc(sentences(d.nextStep).slice(-2).join(" "), 300) : null,
    },
  ];

  let out = assemble(sections, d.droppedCount);
  // trim oldest items from the largest section until under the cap.
  while (out.length > CHAR_CAP) {
    let biggest: Section | null = null;
    for (const s of sections) {
      if (s.items && s.items.length > 0 && (!biggest || s.items.length > biggest.items!.length)) {
        biggest = s;
      }
    }
    if (!biggest?.items) break;
    biggest.items.shift();
    out = assemble(sections, d.droppedCount);
  }
  return out.length > CHAR_CAP ? `${out.slice(0, CHAR_CAP - 3)}...` : out;
}

const NEEDLE_MIN = 12; // shorter needles match by accident

function norm(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Drop digest items the compact summary already carries, via cheap normalized substring match. */
export function excludeCovered(d: Digest, summaryRaw: string): Digest {
  if (!summaryRaw) return d;
  const summary = norm(summaryRaw);
  const covered = (item: string) => {
    const needle = norm(item).slice(0, 60);
    return needle.length >= NEEDLE_MIN && summary.includes(needle);
  };
  const pathCovered = (p: string) => {
    const tail = p.split("/").filter(Boolean).slice(-2).join("/").toLowerCase();
    return tail.length >= NEEDLE_MIN && summary.includes(tail);
  };
  // Dead-end lines are our own phrasing; match on the backticked command inside instead.
  const deadEndCovered = (line: string) => {
    const m = line.match(/`([^`]+)`/);
    return m ? covered(m[1] ?? "") : false;
  };

  return {
    ...d,
    // activeTask is exempt: never null the one orienting line even if the summary mentions it.
    edits: d.edits.filter((e) => !pathCovered(e.path)),
    commands: d.commands.filter((c) => !covered(c.command)),
    deadEnds: d.deadEnds.filter((x) => !deadEndCovered(x)),
    constraints: d.constraints.filter((c) => !covered(c)),
    nextStep: d.nextStep && covered(d.nextStep) ? null : d.nextStep,
  };
}

/** True when the digest has no extractable content (inject should then stay silent). */
export function isEmpty(d: Digest): boolean {
  return (
    !d.activeTask &&
    d.edits.length === 0 &&
    d.commands.length === 0 &&
    d.deadEnds.length === 0 &&
    d.constraints.length === 0 &&
    !d.nextStep
  );
}

/** Full pipeline: records → dropped set → digest. null when there is no matching boundary. */
export function digestFrom(records: Rec[], nthFromLast = 1): Digest | null {
  const split = splitAtBoundary(records, nthFromLast);
  if (!split) return null;
  return excludeCovered(extract(split.dropped), split.summary);
}

export function digestPath(path: string, nthFromLast = 1): Digest | null {
  return digestFrom(readRecords(path), nthFromLast);
}

/** inject-mode digest of the just-compacted tail — no preserved filter or summary dedupe, neither
 * is on disk at hook time. An empty tail (boundary flushed first) falls back to the boundary diff. */
export function digestInject(records: Rec[]): Digest | null {
  const d = extract(tailAfterLastBoundary(records));
  return isEmpty(d) ? digestFrom(records, 1) : d;
}
