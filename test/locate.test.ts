import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { configDir, locate } from "../src/locate.js";

function withConfigDir<T>(dir: string | undefined, fn: () => T): T {
  const prev = process.env.CLAUDE_CONFIG_DIR;
  if (dir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
  }
}

describe("configDir", () => {
  test("honors CLAUDE_CONFIG_DIR, falls back to ~/.claude when blank", () => {
    expect(withConfigDir("/custom/dir", configDir)).toBe("/custom/dir");
    expect(withConfigDir("   ", configDir)).toBe(join(homedir(), ".claude"));
    expect(withConfigDir(undefined, configDir)).toBe(join(homedir(), ".claude"));
  });
});

describe("locate", () => {
  test("--transcript is returned verbatim", () => {
    expect(locate({ transcript: "/any/where.jsonl" })).toBe("/any/where.jsonl");
  });

  test("cwd is encoded (/ and . → -), and /a/b.c collides with /a/b/c by design", () => {
    const a = withConfigDir("/cfg", () => locate({ session: "s1", cwd: "/a/b.c" }));
    const b = withConfigDir("/cfg", () => locate({ session: "s1", cwd: "/a/b/c" }));
    expect(a).toBe("/cfg/projects/-a-b-c/s1.jsonl");
    expect(b).toBe(a);
  });

  test("--session returns the path with no existence check (keeps inject silent)", () => {
    const p = withConfigDir("/cfg", () => locate({ session: "ghost", cwd: "/proj/x" }));
    expect(p).toBe("/cfg/projects/-proj-x/ghost.jsonl");
  });

  test("newest transcript by mtime wins; a missing project dir yields null", () => {
    const cfg = mkdtempSync(join(tmpdir(), "unforget-locate-"));
    const dir = join(cfg, "projects", "-proj-x");
    mkdirSync(dir, { recursive: true });
    const older = join(dir, "older.jsonl");
    const newer = join(dir, "newer.jsonl");
    writeFileSync(older, "{}\n");
    writeFileSync(newer, "{}\n");
    utimesSync(older, new Date(1000), new Date(1000));
    utimesSync(newer, new Date(2000), new Date(2000));

    expect(withConfigDir(cfg, () => locate({ cwd: "/proj/x" }))).toBe(newer);
    expect(withConfigDir(cfg, () => locate({ cwd: "/no/such/proj" }))).toBeNull();
  });
});
