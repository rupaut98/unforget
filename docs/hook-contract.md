# Hook contract (verified empirically)

Measured with a logging-hook spike in headless `-p` mode on claude 2.1.201 (2026-07-05).
Web docs conflict with this; trust these measurements and re-verify on major version bumps.

## Event order for one compaction

`SessionStart:resume` → `PreCompact` → (summary generated) → `SessionStart` with
`source:"compact"` → `PostCompact` → `SessionEnd`. All share one `prompt_id`.

## Injection point

`SessionStart` (matcher `compact`) stdout IS injected into the fresh post-compaction context,
wrapped as `SessionStart:compact hook success: <stdout>`. Claude Code truncates injected
context at 10,000 chars (overflow spills to a file preview) — hence our 9,500 digest cap.

## Payloads

- `PreCompact`: `trigger:"manual"|"auto"`, `custom_instructions` (verbatim for
  `/compact <text>`, null otherwise), `transcript_path`, `prompt_id`. Exit code 2 blocks
  compaction entirely — no boundary written, no model call.
- `PostCompact`: carries `compact_summary`, the full summary text. Usable as an exclusion
  filter so the digest injects only what the summary genuinely lost.

## Transcript on disk

Append-only across compaction. The boundary record is `type:"system"`,
`subtype:"compact_boundary"` with `compactMetadata.preservedMessages.allUuids` (the survived
set) plus `preTokens`/`postTokens`/`cumulativeDroppedTokens`. The summary follows as a
`type:"user"` record with `isCompactSummary:true`.

## Upstream bugs to design around

- Plugin-packaged SessionStart hooks get their output dropped (anthropics/claude-code#16538):
  install at settings level, never as a plugin.
- Microcompact fires no hooks at all.
- PreCompact reliability has a history (#13572): nothing load-bearing may depend on PreCompact
  firing — the on-disk boundary diff is the source of truth.
