import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRecords } from "../src/parse.js";

describe("tolerant parsing (invariant 4)", () => {
  test("a malformed line is skipped, valid neighbors kept", () => {
    const p = join(mkdtempSync(join(tmpdir(), "unforget-parse-")), "t.jsonl");
    writeFileSync(
      p,
      '{"type":"user","uuid":"a"}\n{oops truncated\n{"type":"assistant","uuid":"b"}\n',
    );
    expect(readRecords(p).map((r) => r.uuid)).toEqual(["a", "b"]);
  });

  test("a missing file yields []", () => {
    expect(readRecords("/nonexistent/nope.jsonl")).toEqual([]);
  });
});
