import { readFileSync } from "node:fs";

// Transcript lines are untyped JSON written by Claude Code; we validate fields as we read them.
// biome-ignore lint/suspicious/noExplicitAny: transcript records are free-form JSON
export type Rec = any;

/** A tool_use / tool_result / text content block inside a message. */
// biome-ignore lint/suspicious/noExplicitAny: block shape varies by type
export type Block = any;

/** Read a transcript file into records; one bad line is skipped, a missing file yields []. */
export function readRecords(path: string): Rec[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: Rec[] = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // tolerant: a truncated/half-written last line never crashes the reader
    }
  }
  return out;
}

/** message.content blocks as an array (empty when content is a bare string or absent). */
export function blocks(rec: Rec): Block[] {
  const c = rec?.message?.content;
  return Array.isArray(c) ? c : [];
}

/** Plain text of a message: the string content, or its joined text blocks. */
export function messageText(rec: Rec): string {
  const c = rec?.message?.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n")
    .trim();
}

/** Text of a tool_result block, whether its content is a string or an array of text blocks. */
export function resultText(block: Block): string {
  const c = block?.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c
    .filter((b) => typeof b?.text === "string")
    .map((b) => b.text as string)
    .join("\n");
}
