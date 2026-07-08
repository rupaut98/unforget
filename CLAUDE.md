# unforget

CLI that re-injects the working state Claude Code loses on context compaction. Reads the
on-disk transcript (append-only, survives compaction), diffs dropped messages against the
preserved set, prints a markdown digest that a SessionStart hook feeds back into fresh context.

Never commit or push automatically. Stage changes, show the message, wait for a go-ahead.

Commands:

- run: bun src/cli.ts
- test: bun test
- lint: biome check src test
- typecheck: bunx tsc --noEmit
- build: tsdown

Keep all four green.

Modules: cli.ts (dispatch: inject default, digest, doctor, init), locate.ts (resolve transcript),
digest.ts (boundary diff, hook-time tail window, extraction, summary-dedupe, render, injection
freshness; the TOOL display name and shared regexes live here — retro imports them, never copies),
init.ts (settings.json hook writer: symlink-safe, backup, confirm-first),
parse.ts (tolerant JSONL reading).

Every extraction filter gets a row in docs/HEURISTICS.md (what it catches + the finding that
motivated it). The go-public bar is pre-registered in bench/CRITERIA.md (local-only, gitignored
like bench/baseline-*.txt — personal dogfooding data never ships).

Invariants:

1. Zero runtime deps: package.json dependencies stays {}.
2. inject is a silent no-op on missing data or any error: print nothing, exit 0. A hook must
   never emit noise.
3. No network, ever. Reads under ~/.claude (or $CLAUDE_CONFIG_DIR) are read-only; we write only
   our own settings block, and only when the user opts in.
4. Tolerant parsing: a bad JSONL line is skipped, a missing file yields empty, never a crash.
5. The digest is built from dropped records only, capped at 9,500 chars, trimming oldest first.
   The built-in compact summary is read ONLY to exclude items it already carries — never as a
   content source.

Hook wiring is version-sensitive: read docs/hook-contract.md (empirically verified on 2.1.201)
before touching it — web docs conflict with measured behavior.
