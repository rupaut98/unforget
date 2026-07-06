import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

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
