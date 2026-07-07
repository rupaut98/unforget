#!/usr/bin/env node
import { readSync } from "node:fs";
import { parseArgs } from "node:util";
import { digestPath, isEmpty, render, TOOL } from "./digest.js";
import { applyInit, hookEntry, settingsPath } from "./init.js";
import { locate } from "./locate.js";

declare const __VERSION__: string;
const VERSION = typeof __VERSION__ !== "undefined" ? __VERSION__ : "dev";

const HELP = `${TOOL} — re-inject the working state Claude Code loses when it compacts context

Usage
  ${TOOL} [command] [options]

Commands
  inject               (default) print the recovered digest for the current project.
                       Silent no-op (exit 0, no output) when there is nothing to recover —
                       safe to wire to a SessionStart hook.
  digest               same digest, for human inspection (prints a note when empty)
  init                 add the SessionStart hook to your Claude settings (shows the change,
                       asks first, backs up; idempotent). --remove uninstalls, --yes skips
                       the prompt, --print just shows the hooks block

Options
  --transcript <path>  read this transcript instead of auto-locating one
  --session <id>       scope to one session id (current project)
  --boundary <n>       use the Nth compact boundary from the end (default 1 = last)
  --json               machine-readable digest (digest command)
  -h, --help           this help
  -v, --version        print version

Reads ~/.claude (or $CLAUDE_CONFIG_DIR) locally. Never sends data anywhere.`;

/** Blocking y/N prompt; unreadable stdin counts as "no". */
function askYesNo(question: string): boolean {
  process.stdout.write(question);
  try {
    const buf = Buffer.alloc(64);
    const n = readSync(0, buf, 0, 64, null);
    return /^y(es)?$/i.test(buf.toString("utf8", 0, n).trim());
  } catch {
    process.stdout.write("\n");
    return false;
  }
}

function parseBoundary(v: unknown): number {
  if (typeof v !== "string") return 1;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

const OPTIONS = {
  transcript: { type: "string" },
  session: { type: "string" },
  boundary: { type: "string" },
  json: { type: "boolean" },
  print: { type: "boolean" },
  remove: { type: "boolean" },
  yes: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
} as const;

function main(): void {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ allowPositionals: true, options: OPTIONS });
  } catch (e) {
    // Silent hook: malformed args on the default inject path must never make session start noisy.
    const cmd = process.argv.slice(2).find((a) => !a.startsWith("-"));
    if (cmd === undefined || cmd === "inject") return;
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
    return;
  }
  const v = parsed.values;
  const cmd = parsed.positionals[0] ?? "inject";

  if (v.help) return void console.log(HELP);
  if (v.version) return void console.log(VERSION);

  if (cmd === "init") {
    if (v.print) {
      return void console.log(JSON.stringify({ hooks: { SessionStart: [hookEntry()] } }, null, 2));
    }
    const confirm = v.yes
      ? (msg: string) => {
          console.log(msg);
          return true;
        }
      : (msg: string) => askYesNo(`${msg}\nwrite? [y/N] `);
    applyInit(settingsPath(), v.remove ?? false, confirm);
    return;
  }

  const nth = parseBoundary(v.boundary);
  const path = locate({ transcript: v.transcript, session: v.session });

  if (cmd === "inject") {
    // Silent hook: any failure or missing data ends as a silent exit 0.
    try {
      if (!path) return;
      const d = digestPath(path, nth);
      if (!d || isEmpty(d)) return;
      process.stdout.write(`${render(d)}\n`);
    } catch {
      return;
    }
    return;
  }

  if (cmd === "digest") {
    if (!path) {
      process.stderr.write("no transcript found for this project (try --transcript <path>)\n");
      return;
    }
    const d = digestPath(path, nth);
    if (v.json) {
      process.stdout.write(`${JSON.stringify(d, null, 2)}\n`);
      return;
    }
    if (!d) {
      process.stderr.write("no compact boundary found in this transcript — nothing to recover\n");
      return;
    }
    if (isEmpty(d)) {
      process.stderr.write("compaction found, but no working state could be extracted\n");
      return;
    }
    process.stdout.write(`${render(d)}\n`);
    return;
  }

  process.stderr.write(`unknown command: ${cmd}\n\n${HELP}\n`);
  process.exitCode = 1;
}

main();
