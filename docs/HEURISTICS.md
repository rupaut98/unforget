# Heuristics ledger

Every extraction filter is a measured decision, not a patch. When adding a filter, add a row:
what it catches and the concrete finding that motivated it. Filters live in `src/digest.ts`
unless noted.

| Filter | Catches | Motivating finding |
| --- | --- | --- |
| `CONTINUATION_RE` + `SUBSTANTIAL` | "continue"/"ok" nudges standing in as the active task | corpus replay: short nudges outranked the real ask |
| `isSubstantiveUser` `<`/`/` skip | command wrappers, injected XML, slash commands | command records were selected as asks |
| `<teammate-message` filter | cross-session notifications relayed as user messages | real boundary: a teammate ping won active-task |
| `pasteRatio` + columnar check | pasted terminal output | real boundary: a pasted `make run` table won active-task |
| `looksLikeReport` demotion | pasted status recaps (numbered lines, headers, `**bold:**`) | 2026-07-06: a recap beat the real instruction |
| constraints only from real asks | stray "never/don't" inside pasted policy or teammate text | relayed policy text produced bogus constraints |
| `REJECTED_RE` | permission-declined tool calls that never ran | declined `is_error` results scored as failures |
| `SEARCH_RE` no-match rule | grep/rg/find/ls nonzero exits meaning "no match" | search misses flooded the failure list |
| `TEST_RE` runner requirement | paths that merely contain "test" | `src/test/x` matched as a test command |
| `-e` exclusion in test detection | inline `node -e "...test..."` scripts | inline scripts misread as the project test run |
| `SCRATCH_RE` | /tmp and ~/.claude writes | scratchpad and memory writes listed as in-flight edits |
| failures-only rendering (`commandItems`) | successful-command spam | real boundaries: successes were ~89% of items, almost never useful |
| summary dedupe is exclusion-only | double-injecting what the summary kept | invariant 5: the summary is never a content source |
| hook-time tail window (`tailAfterLastBoundary`) | one-compaction-stale injections | 2026-07-07: the boundary is flushed AFTER hooks run (hook-contract.md) |
| footer-count freshness (`injectionStatus`) | crediting stale injections as interventional data | same finding; shared by `bench/retro.ts` and `doctor` |
| `IMAGE_PLACEHOLDER_RE` strip | `[Image #N]` placeholders polluting task/constraint lines | 2026-07-21 corpus replay: 4 of 10 flagged active-tasks were fine asks wearing image placeholders |
| `looksLikePaste` (prose-line majority) | pasted output of ANY tool (psql tables, shell sessions, stack traces) winning active-task | 2026-07-21: a psql fragment and a React trace each won the slot; per-format regexes rejected as a treadmill (a psql-only fix needed 3 prompt variants in one sitting) |

Validation: `bench/retro.ts` replays every real compact boundary on this machine and gates
NET AVOIDED% at a floor — any filter change that loses working state fails the run.
