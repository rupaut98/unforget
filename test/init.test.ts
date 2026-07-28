import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyInit,
  FRAGILE_PATH,
  hookCommand,
  hookEntry,
  isInstalled,
  withHook,
  withoutHook,
} from "../src/init.js";

describe("hook merge logic", () => {
  test("adds our entry, preserving everything else", () => {
    const s = {
      model: "opus",
      hooks: { SessionStart: [{ matcher: "startup", hooks: [{ command: "echo hi" }] }] },
    };
    const next = withHook(s)!;
    expect(next.model).toBe("opus");
    expect(next.hooks!.SessionStart).toHaveLength(2);
    expect(isInstalled(next)).toBe(true);
    expect(isInstalled(s)).toBe(false);
  });

  test("idempotent: already installed → null, incl. a hand-written bare command", () => {
    expect(withHook({ hooks: { SessionStart: [hookEntry()] } })).toBeNull();
    const bare = { matcher: "compact", hooks: [{ command: "unforget inject" }] };
    expect(withHook({ hooks: { SessionStart: [bare] } })).toBeNull();
  });

  test("hook command is absolute runtime + script path", () => {
    const cmd = hookCommand();
    expect(cmd).toContain(process.execPath);
    expect(cmd).toEndWith(" inject");
  });

  test("fragile-path warning fires on ephemeral installs, not on a version-independent shim", () => {
    // the observed breakage: a bunx temp dir, wiped by the OS days later
    expect(
      FRAGILE_PATH.test(
        '"/Users/x/.bun/bin/bun" "/var/folders/f5/q/T/bunx-501-unforget@latest/node_modules/.bin/unforget" inject',
      ),
    ).toBe(true);
    expect(FRAGILE_PATH.test("/Users/x/.local/share/mise/installs/node/22.22.2/bin/node")).toBe(
      true,
    );
    expect(FRAGILE_PATH.test("/Users/x/.nvm/versions/node/v20.11.0/bin/node")).toBe(true);
    expect(FRAGILE_PATH.test("/opt/homebrew/Cellar/node/24.2.0/bin/node")).toBe(true);
    expect(
      FRAGILE_PATH.test("/Users/x/.local/share/fnm/node-versions/v20/installation/bin/node"),
    ).toBe(true);
    expect(FRAGILE_PATH.test("/Users/x/.local/share/mise/shims/node")).toBe(false);
    expect(FRAGILE_PATH.test("/Users/x/.asdf/shims/node")).toBe(false);
    expect(FRAGILE_PATH.test("/usr/local/bin/node")).toBe(false);
  });

  test("remove strips only our entry and cleans empty containers", () => {
    const other = { matcher: "startup", hooks: [{ command: "echo hi" }] };
    const both = { hooks: { SessionStart: [other, hookEntry()] } };
    expect(withoutHook(both)!.hooks!.SessionStart).toEqual([other]);
    const onlyOurs = { keep: 1, hooks: { SessionStart: [hookEntry()] } };
    expect(withoutHook(onlyOurs)).toEqual({ keep: 1 });
    expect(withoutHook({})).toBeNull();
  });
});

describe("applyInit writes through symlinks", () => {
  test("install via symlink edits the target, keeps the link, leaves a backup", () => {
    const dir = mkdtempSync(join(tmpdir(), "unforget-init-"));
    const real = join(dir, "real-settings.json");
    const link = join(dir, "settings.json");
    writeFileSync(real, JSON.stringify({ model: "opus" }));
    symlinkSync(real, link);

    applyInit(link, false, () => true);

    const written = JSON.parse(readFileSync(real, "utf8"));
    expect(written.model).toBe("opus");
    expect(isInstalled(written)).toBe(true);
    expect(JSON.parse(readFileSync(link, "utf8"))).toEqual(written);
    expect(JSON.parse(readFileSync(`${real}.unforget.bak`, "utf8"))).toEqual({ model: "opus" });
  });

  test("declined confirm writes nothing; invalid JSON aborts", () => {
    const dir = mkdtempSync(join(tmpdir(), "unforget-init-"));
    const p = join(dir, "settings.json");
    writeFileSync(p, "{not json");
    applyInit(p, false, () => true);
    expect(readFileSync(p, "utf8")).toBe("{not json");
    process.exitCode = 0;

    writeFileSync(p, "{}");
    applyInit(p, false, () => false);
    expect(readFileSync(p, "utf8")).toBe("{}");
  });

  test("valid-JSON-but-non-object root aborts (an array would be spread into junk keys)", () => {
    const dir = mkdtempSync(join(tmpdir(), "unforget-init-"));
    const p = join(dir, "settings.json");
    writeFileSync(p, "[]");
    applyInit(p, false, () => true);
    expect(readFileSync(p, "utf8")).toBe("[]");
    process.exitCode = 0;
  });
});
