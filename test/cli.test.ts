import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./fixtures/session.jsonl", import.meta.url));

describe("inject silence invariant", () => {
  test("unknown flag: no output, exit 0 (a typo'd hook command must stay quiet)", () => {
    const r = spawnSync("bun", [CLI, "inject", "--bogus"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
  });

  test("digest reports unknown flags loudly", () => {
    const r = spawnSync("bun", [CLI, "digest", "--bogus"], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).not.toBe("");
  });
});

describe("inject reads the transcript from hook stdin", () => {
  test("stdin transcript_path is honored when locate() would find nothing", () => {
    const empty = mkdtempSync(join(tmpdir(), "unforget-stdin-"));
    const env = { ...process.env, CLAUDE_CONFIG_DIR: empty };
    const piped = spawnSync("bun", [CLI, "inject"], {
      encoding: "utf8",
      env,
      input: JSON.stringify({ transcript_path: FIXTURE }),
    });
    expect(piped.status).toBe(0);
    expect(piped.stdout).toContain("Working state restored");

    // without the stdin path, locate() finds nothing → silent
    const bare = spawnSync("bun", [CLI, "inject"], { encoding: "utf8", env, input: "" });
    expect(bare.stdout).toBe("");
  });

});

describe("digest positional path", () => {
  test("`digest <path>` reads that transcript instead of auto-locating", () => {
    const empty = mkdtempSync(join(tmpdir(), "unforget-positional-"));
    const r = spawnSync("bun", [CLI, "digest", FIXTURE], {
      encoding: "utf8",
      env: { ...process.env, CLAUDE_CONFIG_DIR: empty },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Working state restored");
  });
});

describe("doctor", () => {
  test("exits 0 and reports on an empty config dir (never installed, no transcript)", () => {
    const empty = mkdtempSync(join(tmpdir(), "unforget-doctor-"));
    const r = spawnSync("bun", [CLI, "doctor"], {
      encoding: "utf8",
      env: { ...process.env, CLAUDE_CONFIG_DIR: empty },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("hook NOT installed");
    expect(r.stdout).toContain("no transcript found");
  });
});
