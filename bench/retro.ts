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
  REJECTED_RE,
  render,
  SCRATCH_RE,
  splitAtBoundary,
} from "../src/digest.js";
import { blocks, type Rec, readRecords, resultText } from "../src/parse.js";

// Measured on the author's corpus 2026-07-07: NET 96.0%; FLOOR sits below it to guard regressions.
const FLOOR = 85;

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
}

/** ORACLE from the post-boundary window: what the resumed session actually touched. */
function oracleState(window: Rec[]): Oracle {
  const files = new Set<string>();
  const commands = new Set<string>();
  for (const rec of window) {
    if (rec?.type !== "user" && rec?.type !== "assistant") continue;
    if (rec?.isMeta || rec?.isSidechain) continue;
    for (const b of blocks(rec)) {
      if (b?.type !== "tool_use") continue;
      const input = b.input ?? {};
      if (
        (b.name === "Read" || b.name === "Edit" || b.name === "Write") &&
        typeof input.file_path === "string" &&
        !SCRATCH_RE.test(input.file_path)
      ) {
        files.add(fileKey(input.file_path));
      }
      if (b.name === "Bash" && typeof input.command === "string") {
        commands.add(cmdSig(input.command));
      }
    }
  }
  return { files, commands };
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
  precision: number | null; // null when the digest had no scorable items
}

function scoreBoundary(
  records: Rec[],
  nthFromLast: number,
  window: Rec[],
): Omit<Row, "name" | "boundary" | "injected"> {
  const split = splitAtBoundary(records, nthFromLast);
  const digest = digestFrom(records, nthFromLast);
  if (!split || !digest) {
    return { dropped: 0, rediscovery: 0, avoided: 0, lost: 0, avoidedNet: 0, precision: null };
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
  const tally = (key: string, inDigest: boolean) => {
    rediscovery++;
    if (inDigest) avoided++;
    if (!summaryNorm.includes(key)) {
      lost++;
      if (inDigest) avoidedNet++;
    }
  };
  for (const f of pre.editedFiles) {
    if (!oracle.files.has(f)) continue; // resumed session went back to a file it had edited
    tally(f, renderedNorm.includes(f));
  }
  for (const c of pre.failedCmds) {
    if (!cmdHit(oracle.commands, c)) continue; // resumed session re-ran a command that had failed
    const key = c.slice(0, CMD_KEY);
    tally(key, renderedNorm.includes(key));
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
    precision: items > 0 ? hit / items : null,
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
  console.log(`median precision:        ${medPrec.toFixed(1)}%`);
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
}

main();
