#!/usr/bin/env node
import { existsSync, readFileSync, readSync, realpathSync } from "node:fs";
import { parseArgs } from "node:util";
import { digestInject, digestPath, injectionStatus, isEmpty, render, TOOL } from "./digest.js";
import { applyInit, hookEntry, installedCommand, settingsPath } from "./init.js";
import { locate } from "./locate.js";
import { readRecords } from "./parse.js";

declare const __VERSION__: string;
const VERSION = typeof __VERSION__ !== "undefined" ? __VERSION__ : "dev";

const HELP = `${TOOL} — re-inject the working state Claude Code loses when it compacts context

Usage
  ${TOOL} [command] [options]

Commands
  inject               (default) print the recovered digest for the current project.
                       Silent no-op (exit 0, no output) when there is nothing to recover —
                       safe to wire to a SessionStart hook.
  digest [path]        same digest, for human inspection (prints a note when empty)
  doctor               end-to-end health check: hook installed, runtime paths on disk,
                       transcript locatable, last injection fresh. Always exits 0.
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

/** transcript_path from the hook's stdin JSON (SessionStart passes it); TTY/empty/bad → null. */
function stdinTranscriptPath(): string | null {
  if (process.stdin.isTTY) return null;
  try {
    const p = JSON.parse(readFileSync(0, "utf8"))?.transcript_path;
    return typeof p === "string" && p !== "" ? p : null;
  } catch {
    return null;
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
  const path = locate({ transcript: v.transcript ?? parsed.positionals[1], session: v.session });

  if (cmd === "doctor") {
    // Diagnostic only, exit 0 always: inject is silent-by-design, so death is otherwise invisible.
    let hookCmd: string | null = null;
    try {
      hookCmd = installedCommand(JSON.parse(readFileSync(realpathSync(settingsPath()), "utf8")));
    } catch {}
    if (!hookCmd) {
      console.log(`hook NOT installed in ${settingsPath()} — run \`${TOOL} init\``);
    } else {
      console.log(`hook installed: ${hookCmd}`);
      // quoted paths in the hook command (runtime + script) must exist, or the hook is silently dead.
      for (const [, p] of hookCmd.matchAll(/"([^"]+)"/g)) {
        if (p && !existsSync(p)) {
          console.log(`MISSING path ${p} — hook is silently dead; re-run \`${TOOL} init\``);
        }
      }
    }
    if (!path) {
      console.log("no transcript found for this project — nothing has run here yet?");
      return;
    }
    console.log(`transcript: ${path}`);
    const msg = {
      fresh: "last injection: fresh — hook verified end to end",
      stale: "last injection: STALE — digest matched the previous window, not this one",
      none: "last compaction had NO injection — the hook did not fire or died silently",
      "no-boundary": "no compaction in this transcript yet — nothing to verify",
    };
    console.log(msg[injectionStatus(readRecords(path))]);
    return;
  }

  if (cmd === "inject") {
    // Silent hook: any failure or missing data ends as a silent exit 0.
    try {
      const injectPath = v.transcript ?? stdinTranscriptPath() ?? path;
      if (!injectPath) return;
      const d = digestInject(readRecords(injectPath));
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
