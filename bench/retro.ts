// Retro-scorer: replays real compact boundaries, asking if the digest carried the state the
// resumed session went back to rediscover (re-read an edited file / re-ran a failed command).
// NET AVOIDED% = share of rediscoveries the built-in summary did NOT carry that the digest did.
// Scores YOUR OWN ~/.claude corpus (or $CLAUDE_CONFIG_DIR): the number is reproducible per machine,
// not a fixed published figure. Run: bun bench/retro.ts   (zero deps, read-only, network-free)

import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  boundaryIndices,
  digestFrom,
  fileKey,
  injectionStatus,
  looksLikePaste,
  REJECTED_RE,
  render,
  SCRATCH_RE,
  splitAtBoundary,
} from "../src/digest.js";
import { blocks, type Rec, readRecords, resultText } from "../src/parse.js";

// Measured on the author's corpus 2026-07-07: NET 96.0%; FLOOR sits below it to guard regressions.
const FLOOR = 85;
// Measured 7.9% (2026-07-21); dump-everything keeps NET high while precision collapses.
const PRECISION_FLOOR = 5;

/** Normalized command signature: strip a leading `cd …;`/`cd … &&`, collapse whitespace, 60 chars. */
function cmdSig(cmd: string): string {
  return cmd
    .replace(/^\s*cd\s+[^;&]+(?:;|&&)\s*/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .slice(0, 60);
}

const CMD_KEY = 40; // commands match on their first 40 normalized chars
// chars/4 estimate; a real tokenizer only if a headline number ever needs to be exact.
const tokens = (s: string): number => Math.round(s.length / 4);

interface Pre {
  editedFiles: Set<string>;
  failedCmds: Set<string>;
}

/** PRE state from the dropped set: files that were edited, commands that genuinely failed. */
function preState(dropped: Rec[]): Pre {
  const editedFiles = new Set<string>();
  const failedCmds = new Set<string>();
  const bashById = new Map<string, string>();
  for (const rec of dropped) {
    for (const b of blocks(rec)) {
      if (b?.type === "tool_use") {
        const input = b.input ?? {};
        if (
          (b.name === "Edit" || b.name === "Write") &&
          typeof input.file_path === "string" &&
          !SCRATCH_RE.test(input.file_path)
        ) {
          editedFiles.add(fileKey(input.file_path));
        }
        if (b.name === "Bash" && typeof input.command === "string" && typeof b.id === "string") {
          bashById.set(b.id, input.command);
        }
      }
      if (b?.type === "tool_result" && typeof b.tool_use_id === "string" && b.is_error === true) {
        const cmd = bashById.get(b.tool_use_id);
        if (cmd === undefined || REJECTED_RE.test(resultText(b))) continue;
        failedCmds.add(cmdSig(cmd));
      }
    }
  }
  return { editedFiles, failedCmds };
}

interface Oracle {
  files: Set<string>;
  commands: Set<string>;
  // tokens of each key's first redundant re-read/re-run — re-work the digest could spare.
  fileCost: Map<string, number>;
  cmdCost: Map<string, number>;
}

/** Post-boundary re-touches, with each key's first re-read/re-run cost (tool_use → tool_result). */
function oracleState(window: Rec[]): Oracle {
  const files = new Set<string>();
  const commands = new Set<string>();
  const fileCost = new Map<string, number>();
  const cmdCost = new Map<string, number>();
  const costRef = new Map<string, { cost: Map<string, number>; key: string }>();
  for (const rec of window) {
    if (rec?.type !== "user" && rec?.type !== "assistant") continue;
    if (rec?.isMeta || rec?.isSidechain) continue;
    for (const b of blocks(rec)) {
      if (b?.type === "tool_use") {
        const input = b.input ?? {};
        if (
          (b.name === "Read" || b.name === "Edit" || b.name === "Write") &&
          typeof input.file_path === "string" &&
          !SCRATCH_RE.test(input.file_path)
        ) {
          const key = fileKey(input.file_path);
          files.add(key);
          // only a re-Read pulls file content back into context; Edit/Write results are trivial.
          if (b.name === "Read" && typeof b.id === "string")
            costRef.set(b.id, { cost: fileCost, key });
        }
        if (b.name === "Bash" && typeof input.command === "string") {
          const sig = cmdSig(input.command);
          commands.add(sig);
          if (typeof b.id === "string")
            costRef.set(b.id, { cost: cmdCost, key: sig.slice(0, CMD_KEY) });
        }
      } else if (b?.type === "tool_result" && typeof b.tool_use_id === "string") {
        const ref = costRef.get(b.tool_use_id);
        if (ref && !ref.cost.has(ref.key)) ref.cost.set(ref.key, tokens(resultText(b)));
      }
    }
  }
  return { files, commands, fileCost, cmdCost };
}

/** True when a normalized signature set contains a first-CMD_KEY-chars match for `sig`. */
function cmdHit(set: Set<string>, sig: string): boolean {
  if (sig.length < 8) return false;
  const key = sig.slice(0, CMD_KEY);
  for (const s of set) if (s.slice(0, CMD_KEY) === key) return true;
  return false;
}

interface Row {
  name: string;
  boundary: number;
  injected: boolean; // digest was live-injected at this boundary (post-install data)
  dropped: number;
  rediscovery: number;
  avoided: number;
  lost: number; // rediscovery events the compact summary did NOT carry
  avoidedNet: number; // of those, how many the digest carried
  carriedTokens: number; // est. tokens of the net-avoided re-reads/re-runs the digest held
  precision: number | null; // null when the digest had no scorable items
  pasteTask: boolean; // activeTask reads as pasted output — gated at 0
}

function scoreBoundary(
  records: Rec[],
  nthFromLast: number,
  window: Rec[],
): Omit<Row, "name" | "boundary" | "injected"> {
  const split = splitAtBoundary(records, nthFromLast);
  const digest = digestFrom(records, nthFromLast);
  if (!split || !digest) {
    return {
      dropped: 0,
      rediscovery: 0,
      avoided: 0,
      lost: 0,
      avoidedNet: 0,
      carriedTokens: 0,
      precision: null,
      pasteTask: false,
    };
  }

  const pre = preState(split.dropped);
  const oracle = oracleState(window);
  const renderedNorm = render(digest).replace(/\s+/g, " ").toLowerCase();
  const summaryNorm = split.summary.replace(/\s+/g, " ").toLowerCase();

  // NET counts only events the summary did not carry — a summary-kept item was never "lost".
  let rediscovery = 0;
  let avoided = 0;
  let lost = 0;
  let avoidedNet = 0;
  let carriedTokens = 0;
  const tally = (key: string, inDigest: boolean, cost: number) => {
    rediscovery++;
    if (inDigest) avoided++;
    if (!summaryNorm.includes(key)) {
      lost++;
      if (inDigest) {
        avoidedNet++;
        carriedTokens += cost;
      }
    }
  };
  for (const f of pre.editedFiles) {
    if (!oracle.files.has(f)) continue; // resumed session went back to a file it had edited
    tally(f, renderedNorm.includes(f), oracle.fileCost.get(f) ?? 0);
  }
  for (const c of pre.failedCmds) {
    if (!cmdHit(oracle.commands, c)) continue; // resumed session re-ran a command that had failed
    const key = c.slice(0, CMD_KEY);
    tally(key, renderedNorm.includes(key), oracle.cmdCost.get(key) ?? 0);
  }

  // precision: of the digest's concrete claims, how many the oracle actually used
  let items = 0;
  let hit = 0;
  for (const e of digest.edits) {
    items++;
    if (oracle.files.has(fileKey(e.path))) hit++;
  }
  for (const cmd of digest.commands) {
    items++;
    if (cmdHit(oracle.commands, cmdSig(cmd.command))) hit++;
  }
  if (digest.activeTask) {
    items++;
    // Task "lands" if any oracle file-stem or command-token appears in the task text.
    const task = digest.activeTask.toLowerCase();
    const names = [...oracle.files].map(
      (f) =>
        f
          .split("/")
          .pop()
          ?.replace(/\.\w+$/, "") ?? "",
    );
    const cmds = [...oracle.commands].map((c) => c.split(" ")[0] ?? "");
    if ([...names, ...cmds].some((n) => n.length >= 4 && task.includes(n))) hit++;
  }

  return {
    dropped: split.droppedCount,
    rediscovery,
    avoided,
    lost,
    avoidedNet,
    carriedTokens,
    precision: items > 0 ? hit / items : null,
    pasteTask: digest.activeTask !== null && looksLikePaste(digest.activeTask),
  };
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] ?? 0) : ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function main(): void {
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  const projectsDir = join(configDir, "projects");

  const files: { path: string; name: string }[] = [];
  for (const proj of readdirSync(projectsDir, { withFileTypes: true })) {
    if (!proj.isDirectory()) continue;
    const dir = join(projectsDir, proj.name);
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      // top-level *.jsonl only — a subagents/ subdir (side-channel transcripts) is skipped
      if (!f.isFile() || !f.name.endsWith(".jsonl")) continue;
      files.push({
        path: join(dir, f.name),
        name: `${proj.name.split("-").pop()}/${f.name.slice(0, 8)}`,
      });
    }
  }

  const rows: Row[] = [];
  for (const { path, name } of files) {
    const records = readRecords(path);
    const idxs = boundaryIndices(records);
    for (let pos = 0; pos < idxs.length; pos++) {
      const idx = idxs[pos] ?? 0;
      const end = idxs[pos + 1] ?? records.length;
      const window = records.slice(idx + 1, end);
      const nthFromLast = idxs.length - pos;
      const s = scoreBoundary(records, nthFromLast, window);
      rows.push({
        name,
        boundary: pos + 1,
        injected: injectionStatus(records, nthFromLast) === "fresh",
        ...s,
      });
    }
  }

  // table shows only boundaries with a rediscovery event — the actionable ones
  const active = rows.filter((r) => r.rediscovery > 0);
  console.log(
    pad("transcript", 24) +
      pad("bnd", 5) +
      pad("dropped", 9) +
      pad("redisc", 8) +
      pad("avoid", 7) +
      pad("avoid%", 8) +
      pad("net", 6) +
      "precision",
  );
  console.log("-".repeat(72));
  for (const r of active) {
    const av = r.rediscovery ? (100 * r.avoided) / r.rediscovery : 0;
    console.log(
      pad(r.name, 24) +
        pad(String(r.boundary) + (r.injected ? "*" : ""), 5) +
        pad(String(r.dropped), 9) +
        pad(String(r.rediscovery), 8) +
        pad(String(r.avoided), 7) +
        pad(`${av.toFixed(0)}%`, 8) +
        pad(r.lost ? `${((100 * r.avoidedNet) / r.lost).toFixed(0)}%` : "-", 6) +
        (r.precision === null ? "-" : `${(100 * r.precision).toFixed(0)}%`),
    );
  }

  const totalRedisc = rows.reduce((a, r) => a + r.rediscovery, 0);
  const totalAvoided = rows.reduce((a, r) => a + r.avoided, 0);
  const totalLost = rows.reduce((a, r) => a + r.lost, 0);
  const totalNet = rows.reduce((a, r) => a + r.avoidedNet, 0);
  const totalCarried = rows.reduce((a, r) => a + r.carriedTokens, 0);
  const carriedBoundaries = rows.filter((r) => r.carriedTokens > 0).length;
  const perComp = carriedBoundaries ? Math.round(totalCarried / carriedBoundaries) : 0;
  const avoidedPct = totalRedisc ? (100 * totalAvoided) / totalRedisc : 0;
  const netPct = totalLost ? (100 * totalNet) / totalLost : 0;
  const medPrec = median(
    rows.filter((r) => r.precision !== null).map((r) => 100 * (r.precision ?? 0)),
  );

  console.log("-".repeat(72));
  console.log(
    `boundaries scored:       ${rows.length}  (${active.length} with a rediscovery event)`,
  );
  console.log(`rediscovery events:      ${totalRedisc}  (${totalLost} not carried by the summary)`);
  console.log(`avoided (digest had it): ${totalAvoided}  (${totalNet} of the summary-lost ones)`);
  console.log(`AVOIDED%:                ${avoidedPct.toFixed(1)}%`);
  console.log(
    `NET AVOIDED%:            ${netPct.toFixed(1)}%   <- headline: share of summary-LOST`,
  );
  console.log(`                         rediscoveries the digest carried`);
  console.log(
    `rediscovery tokens held: ~${totalCarried}  (summary-dropped re-reads/re-runs, uncached input, chars/4 est)`,
  );
  console.log(
    `                         ~${perComp} per compaction that needed it — carried, not proven saved (see bench/CRITERIA.md)`,
  );
  const pasteTasks = rows.filter((r) => r.pasteTask);
  console.log(`median precision:        ${medPrec.toFixed(1)}%  (floor ${PRECISION_FLOOR}%)`);
  console.log(`paste-as-active-task:    ${pasteTasks.length}  (gate: 0)`);
  console.log(`floor gate (net):        ${FLOOR}%`);

  // Interventional split: * boundaries had the digest live-injected (hook_success record).
  const pre = rows.filter((r) => !r.injected);
  const post = rows.filter((r) => r.injected);
  const rate = (rs: Row[]) =>
    rs.length ? (rs.reduce((a, r) => a + r.rediscovery, 0) / rs.length).toFixed(2) : "-";
  console.log("-".repeat(72));
  console.log(
    `pre-install (correlational):   ${pre.length} boundaries, ${rate(pre)} rediscoveries/boundary`,
  );
  if (post.length === 0) {
    console.log("post-install (interventional): none yet — keep dogfooding");
  } else {
    console.log(
      `post-install (interventional): ${post.length} boundaries (*), ${rate(post)} rediscoveries/boundary${post.length < 10 ? "  (n small — directional only)" : ""}`,
    );
  }

  if (netPct < FLOOR) {
    console.error(`\nFAIL: NET AVOIDED% ${netPct.toFixed(1)}% is below floor ${FLOOR}%`);
    process.exit(1);
  }
  if (medPrec < PRECISION_FLOOR) {
    console.error(
      `\nFAIL: median precision ${medPrec.toFixed(1)}% is below floor ${PRECISION_FLOOR}%`,
    );
    process.exit(1);
  }
  if (pasteTasks.length > 0) {
    for (const r of pasteTasks)
      console.error(`  paste-as-active-task: ${r.name} bnd ${r.boundary}`);
    console.error(`\nFAIL: ${pasteTasks.length} boundaries chose pasted output as the active task`);
    process.exit(1);
  }
}

main();
