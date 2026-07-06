import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Root of the Claude Code config, honoring $CLAUDE_CONFIG_DIR. */
export function configDir(): string {
  const env = process.env.CLAUDE_CONFIG_DIR;
  return env && env.trim() !== "" ? env : join(homedir(), ".claude");
}

/** Claude Code encodes a project cwd into a dir name by replacing `/` and `.` with `-`. */
function encodeCwd(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

/** Newest top-level (non-subagent) `*.jsonl` in a project dir, by mtime. null if none. */
function newestTranscript(dir: string): string | null {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  let best: string | null = null;
  let bestMtime = -1;
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const full = join(dir, name);
    try {
      const st = statSync(full);
      if (!st.isFile()) continue;
      if (st.mtimeMs > bestMtime) {
        bestMtime = st.mtimeMs;
        best = full;
      }
    } catch {
      // unreadable entry — skip it
    }
  }
  return best;
}

export interface LocateOpts {
  transcript?: string;
  session?: string;
  cwd?: string;
}

/**
 * Resolve which transcript to read:
 *   --transcript <path>  → that file
 *   --session <id>       → <projectDir>/<id>.jsonl (for the current project)
 *   otherwise            → the most recent transcript for the current project cwd
 * Returns null when nothing can be found (callers decide whether that is silent).
 */
export function locate(opts: LocateOpts): string | null {
  if (opts.transcript) return opts.transcript;
  const cwd = opts.cwd ?? process.cwd();
  const dir = join(configDir(), "projects", encodeCwd(cwd));
  if (opts.session) return join(dir, `${opts.session}.jsonl`);
  return newestTranscript(dir);
}
