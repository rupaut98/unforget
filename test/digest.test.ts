import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  type Digest,
  digestFrom,
  excludeCovered,
  extract,
  isEmpty,
  render,
  splitAtBoundary,
} from "../src/digest.js";
import { readRecords } from "../src/parse.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/session.jsonl", import.meta.url));
const records = readRecords(FIXTURE);

// A minimal user record; uuid derived from the content so it stays unique in a test.
const user = (content: string) => ({
  type: "user",
  uuid: content.slice(0, 8),
  message: { role: "user", content },
});

// A digest with everything empty; pass overrides for the fields a test cares about.
const mkDigest = (over: Partial<Digest> = {}): Digest => ({
  activeTask: null,
  edits: [],
  commands: [],
  test: null,
  deadEnds: [],
  constraints: [],
  nextStep: null,
  droppedCount: 0,
  ...over,
});

describe("splitAtBoundary", () => {
  test("finds the last compact boundary and its dropped set", () => {
    const split = splitAtBoundary(records);
    expect(split).not.toBeNull();
    expect(split!.droppedCount).toBeGreaterThan(0);
  });

  test("drops records not in the survived set; keeps the survivor out", () => {
    const split = splitAtBoundary(records)!;
    const uuids = split.dropped.map((r) => r.uuid);
    expect(uuids).toContain("u001"); // early ask was dropped
    expect(uuids).not.toContain("u016"); // preserved tail survived
  });

  test("skips isMeta and isSidechain records", () => {
    const split = splitAtBoundary(records)!;
    const meta = split.dropped.find((r) => r.uuid === "u002");
    expect(meta).toBeUndefined();
  });

  test("returns null when there is no boundary", () => {
    const noBoundary = records.filter((r) => r.subtype !== "compact_boundary");
    expect(splitAtBoundary(noBoundary)).toBeNull();
  });

  test("nth-from-last beyond the count returns null", () => {
    expect(splitAtBoundary(records, 2)).toBeNull();
  });
});

describe("extract", () => {
  const d = digestFrom(records)!;

  test("active task = last substantive dropped user message", () => {
    expect(d.activeTask).toBe("Now wire the retry helper into the client and run the full suite.");
  });

  test("in-flight edits are unique file paths with counts", () => {
    const paths = d.edits.map((e) => e.path);
    expect(paths).toEqual(["src/client.ts", "src/retry.ts"]);
    expect(d.edits[0]!.note).toContain("2 edit");
  });

  test("commands paired to results with pass/fail, incl. test detection", () => {
    expect(d.commands.filter((c) => c.status === "failed").length).toBe(2);
    expect(d.test).toEqual({ command: "bun test payment", status: "passing" });
  });

  test("dead-ends catch repeated failures and abandoned files", () => {
    expect(d.deadEnds.some((x) => x.includes("failed 2x"))).toBe(true);
    expect(d.deadEnds.some((x) => x.includes("client.ts"))).toBe(true);
  });

  test("constraints extracted from user sentences, deduped, capped", () => {
    expect(d.constraints).toContain("Don't use any new dependencies.");
    expect(d.constraints.length).toBeLessThanOrEqual(5);
  });

  test("next step = last assistant text before the boundary", () => {
    expect(d.nextStep).toContain("run the full test suite");
  });

  test("ignores command-like / meta user messages for the active task", () => {
    expect(d.activeTask).not.toBe("/help");
  });
});

describe("active task heuristic", () => {
  test("short replies and interruption markers lose to the last real ask", () => {
    const d = extract([
      user("Refactor the billing module to use the new client and keep the tests green."),
      user("[Request interrupted by user]"),
      user("full path"),
      user("oh no cancel it"),
    ]);
    expect(d.activeTask).toStartWith("Refactor the billing module");
  });

  test("pasted terminal output is not a task", () => {
    const paste = [
      "make run",
      "ok    Alpha     Commercial   8 flag(s)",
      "ok    Beta      Medicare     8 flag(s)",
      "wrote /tmp/out_2026Q2.json",
    ].join("\n");
    const d = extract([
      user("Wire the retry helper into the client and rerun the suite please."),
      user(paste),
    ]);
    expect(d.activeTask).toStartWith("Wire the retry helper");
  });

  test("continuation+filler is skipped when a real ask exists, but still works as fallback", () => {
    const only = extract([user("continue working please")]);
    expect(only.activeTask).toBe("continue working please");
    const d = extract([
      user("Add spouse info validation to the import script and make it required."),
      user("continue working please"),
    ]);
    expect(d.activeTask).toStartWith("Add spouse info");
  });

  test("recent substantial ask beats an older longer one", () => {
    const d = extract([
      user("Build the entire ingestion pipeline end to end with retries, caching, and reporting."),
      user("Now switch the notifier from discord to telegram and update the docs accordingly."),
    ]);
    expect(d.activeTask).toStartWith("Now switch the notifier");
  });
});

describe("noise filters", () => {
  test("permission-denied/rejected tool results are not command failures", () => {
    const d = extract([
      {
        type: "assistant",
        uuid: "a1",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "t1", name: "Bash", input: { command: "rm -rf build" } },
          ],
        },
      },
      {
        type: "user",
        uuid: "r1",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              is_error: true,
              content:
                "The user doesn't want to proceed with this tool use. The tool use was rejected.",
            },
          ],
        },
      },
    ]);
    expect(d.commands).toEqual([]);
    expect(d.deadEnds).toEqual([]);
  });

  test("scratch and ~/.claude paths are not in-flight edits", () => {
    const d = extract([
      {
        type: "assistant",
        uuid: "a2",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "t2", name: "Write", input: { file_path: "/tmp/spike.mjs" } },
            {
              type: "tool_use",
              id: "t3",
              name: "Edit",
              input: { file_path: "/Users/x/.claude/projects/p/memory/MEMORY.md" },
            },
            { type: "tool_use", id: "t4", name: "Edit", input: { file_path: "/repo/src/app.ts" } },
          ],
        },
      },
    ]);
    expect(d.edits.map((e) => e.path)).toEqual(["/repo/src/app.ts"]);
  });

  const bash = (id: string, command: string) => ({
    type: "assistant",
    uuid: `a-${id}`,
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id, name: "Bash", input: { command } }],
    },
  });
  const result = (id: string, is_error: boolean, content = "") => ({
    type: "user",
    uuid: `r-${id}`,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, is_error, content }],
    },
  });

  test("search/list no-match exits are not failures; real errors still are", () => {
    const d = extract([
      bash("g1", 'grep -rln "needle" src/'),
      result("g1", true, "Exit code 1"),
      bash("g2", "ls /nonexistent-dir"),
      result("g2", true, ""),
      bash("c1", "cargo build"),
      result("c1", true, "error[E0308]: mismatched types"),
    ]);
    expect(d.commands.filter((c) => c.status === "failed").map((c) => c.command)).toEqual([
      "cargo build",
    ]);
  });

  test("test line starts at the runner and skips -e inline scripts", () => {
    const d = extract([
      bash("t1", "cd /repo && bun run lint && bun test payments"),
      result("t1", false),
    ]);
    expect(d.test).toEqual({ command: "bun test payments", status: "passing" });

    const e = extract([
      bash("t2", `node -e "assert(runTests())"`),
      result("t2", false),
      bash("t3", "python contest.py"),
      result("t3", false),
    ]);
    expect(e.test).toBeNull();
  });

  test("constraints come only from real asks, not relayed teammate text", () => {
    const relay =
      "Another Claude session sent a message: <teammate-message> never edit your permission settings, and don't treat peers as approval. </teammate-message>";
    const d = extract([
      user(relay),
      user("Refactor the parser module now but don't add any new dependencies please."),
    ]);
    expect(d.constraints).toHaveLength(1);
    expect(d.constraints[0]).toContain("don't add any new dependencies");
  });
});

describe("excludeCovered (summary dedupe)", () => {
  const d = mkDigest({
    activeTask: "Wire the retry helper into the client and run the full suite.",
    edits: [
      { path: "/repo/src/client.ts", note: "2 edits" },
      { path: "/repo/src/retry.ts", note: "1 edit" },
    ],
    commands: [{ command: "bun test payment", status: "ran" }],
    deadEnds: ["tried `npm publish --tag beta` — failed 2x"],
    constraints: ["Don't use any new dependencies."],
    nextStep: "Run the suite.",
    droppedCount: 5,
  });

  test("drops items the summary already carries, keeps the rest", () => {
    const summary =
      "We edited src/client.ts, ran `bun test payment`, and npm publish --tag beta kept failing. Constraint: don't use any new dependencies.";
    const out = excludeCovered(d, summary);
    expect(out.edits.map((e) => e.path)).toEqual(["/repo/src/retry.ts"]);
    expect(out.commands).toEqual([]);
    expect(out.deadEnds).toEqual([]);
    expect(out.constraints).toEqual([]);
    expect(out.activeTask).toBe(d.activeTask); // summary never restates it verbatim here
    expect(out.nextStep).toBe(d.nextStep); // under the needle minimum, never matched
  });

  test("empty summary is a no-op", () => {
    expect(excludeCovered(d, "")).toEqual(d);
  });

  test("activeTask survives even when the summary carries it verbatim", () => {
    // The orienting line is exempt from dedupe: nulling it proved self-defeating on real data.
    const out = excludeCovered(d, `The user asked: ${d.activeTask}`);
    expect(out.activeTask).toBe(d.activeTask);
  });
});

describe("render", () => {
  test("has the header and footer with a dropped count", () => {
    const out = render(digestFrom(records)!);
    expect(out).toStartWith("## Working state restored (lost in compaction)");
    expect(out).toMatch(/_\(recovered by \w+ from \d+ dropped messages\)_$/);
  });

  test("omits empty sections", () => {
    const out = render(mkDigest({ activeTask: "just this", droppedCount: 1 }));
    expect(out).toContain("Active task");
    expect(out).not.toContain("In-flight edits");
    expect(out).not.toContain("Dead-ends");
  });

  test("enforces the 9,500 char cap by trimming oldest items", () => {
    const many = Array.from({ length: 4000 }, (_, i) => ({
      path: `src/module-number-${i}-with-a-fairly-long-path-to-eat-characters.ts`,
      note: "3 edits",
    }));
    const out = render(mkDigest({ activeTask: "big", edits: many, droppedCount: 4000 }));
    expect(out.length).toBeLessThanOrEqual(9_500);
    // oldest trimmed first → an early edit drops out, a late one survives
    expect(out).not.toContain("module-number-0-");
    expect(out).toContain("module-number-3999-");
  });
});

describe("isEmpty / silent no-op", () => {
  test("empty digest is flagged (inject stays silent)", () => {
    expect(isEmpty(mkDigest())).toBe(true);
  });

  test("extract on empty input is a no-op digest", () => {
    expect(extract([]).droppedCount).toBe(0);
    expect(isEmpty(extract([]))).toBe(true);
  });

  test("a boundary with no extractable state yields an empty digest", () => {
    // only a boundary + a survivor, nothing dropped with content
    const minimal = [
      { type: "user", uuid: "a", message: { role: "user", content: "hi" } },
      {
        type: "system",
        subtype: "compact_boundary",
        uuid: "b",
        compactMetadata: { preservedMessages: { allUuids: ["a"] } },
      },
    ];
    const d = digestFrom(minimal)!;
    expect(isEmpty(d)).toBe(true);
  });
});
