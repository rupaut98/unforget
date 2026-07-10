# unforget — PR Review Rules

Reviewing a **local-only, zero-runtime-dependency CLI** that re-injects the working state Claude
Code loses on context compaction. It reads the on-disk transcript under `~/.claude`, diffs what a
compaction dropped, and prints a markdown digest that a `SessionStart` hook feeds back into fresh
context. The pitch: "reads your transcripts locally, never phones home, and the hook is silent —
it never makes session start noisy." Review like the senior engineer who owns this in production.
These rules outrank any default urge to be agreeable, exhaustive, or stylistic.

## Discipline

- **Comment only on `+` lines** (added/modified). Read callers, imports, and sibling helpers for
  context, but the finding must land on a changed line. Don't comment on pre-existing or deleted
  code unless a deletion breaks a contract.
- **Look for what's missing**, not just what's wrong: a new `readFileSync`/`JSON.parse` over
  `~/.claude` with no guard, an `inject`-reachable path that can throw or print on bad data, a new
  extraction filter with no `docs/HEURISTICS.md` row, a render path that can exceed the digest cap.
- **Cite `file:line` that proves every finding.** No inferences from names. Before posting, try to
  refute it — re-read the surrounding code, check whether an existing guard/helper already handles
  it. Can't confirm with a specific `file:line` → drop it. Pass `confirmed=true` on inline comments.

## Severity (label every comment)

- **🔴 Important** — violates a repo invariant below, or otherwise breaks correctness: `inject`
  emits output or throws on the hook path, a network call, a crash on malformed input, a runtime
  dependency, an uncapped digest, or message content written anywhere outside the user's own config.
  Blocks merge.
- **🟡 Nit** — minor correctness/robustness smell, not provably a bug. Never blocking.
- **🟣 Pre-existing** — real bug this PR didn't introduce. Summary mention only; never inline.

## Noise control

- **Skip anything biome / tsc / the build already catch**: formatting, import order, naming,
  `any`, unused vars, type errors. Skip missing docs/comments, test _quantity_, TODOs. No praise.
- **Cap nits at 3** ("plus N similar" in the summary). On **re-review** (your prior comments are
  present), suppress nits — report only new 🔴 issues.
- Skip lockfiles, generated files, `dist/`, `*.md`, `test/fixtures/`, `bench/`, `node_modules/`.
- **Summary** opens with a tally — `**X Important, Y nits**` or `**No blocking issues found.**` —
  then ≤3 sentences. Post inline comments for specific issues; one top-level summary via
  `gh pr comment`. Only post GitHub comments — don't return review text as a chat message.

---

## Repo invariants (violations are 🔴 unless noted)

### 1. `inject` is a silent no-op on any failure

The default `inject` command is wired to a `SessionStart` hook. On missing data **or any error** it
must print **nothing** and exit 0 — a hook must never make session start noisy.

- Flag any `inject`-reachable path that can throw uncaught, write to stderr/stdout on error, or emit
  partial output when there is nothing to recover. The top-level `try/catch` on the `inject` branch
  in `cli.ts` must stay total.
- `digest` and `doctor` are human-facing and *may* print errors; `inject` may not.

### 2. Zero runtime dependencies

`package.json` `dependencies` must stay `{}`. Flag any addition to `dependencies`, or any `import`
of a non-stdlib package in `src/`. Dev tooling stays in `devDependencies`.

### 3. No network; reads are read-only; writes only the opt-in settings block

The tool only **reads** under `~/.claude` (or `$CLAUDE_CONFIG_DIR`) and writes solely its own
`SessionStart` hook into `settings.json`, on explicit opt-in, symlink-safe, with a backup.

- Flag any `fetch`/`http`/`https`/`net` import, telemetry, or analytics ping.
- Flag any write outside the user's own `settings.json`, any write that skips the confirm/backup
  path, or replacing a symlink instead of writing through it to its target. See `init.ts`
  (`applyInit`).
- The help text promises "Never sends data anywhere" — keep it true.

### 4. Tolerant parsing — malformed input never crashes

A bad JSONL line is skipped, a missing file yields empty, never a throw.

- Every `readFileSync`/`JSON.parse`/`readdirSync`/`statSync` over `~/.claude` must be guarded so one
  unreadable / malformed / permission-denied entry is skipped, not fatal. See `parse.ts`
  (`readRecords`) and `locate.ts`.
- Flag a new unguarded read/parse over user-controlled files.

### 5. Digest discipline — dropped records only, capped, summary as filter not source

The digest is built from **dropped** records only, hard-capped at **9,500 characters**, trimming
oldest first. The built-in compact summary is read **only** to exclude items it already carries —
never as a content source.

- Flag any digest content sourced from preserved or summary records, any path that reads summary
  *text* into the digest, or a render path that can exceed the 9,500-char cap. See `digest.ts`
  (`extract`, `excludeCovered`, `render`).

### 6. Boundary & flush-order correctness

`inject` (hook-time) windows from the last **flushed** boundary to end-of-file — the just-compacted
tail — because Claude Code flushes the new boundary only *after* hooks run. `digest` reconstructs
via the boundary diff. Confusing the two re-introduces the "stale previous-window" bug.

- Flag changes to `tailAfterLastBoundary` / `digestInject` / `splitAtBoundary` / `boundaryIndices`
  that assume the new boundary is already on disk at hook time.
- Hook wiring is version-sensitive: a change to the hook command, matcher, or event shape must be
  checked against `docs/hook-contract.md`. Flag edits that contradict it.

### 7. Every extraction filter gets a HEURISTICS.md row

Every new extraction/exclusion filter in the digest pipeline must add a row to `docs/HEURISTICS.md`
(what it catches + the finding that motivated it).

- Flag a new filter/regex in the extraction path with no corresponding `docs/HEURISTICS.md` entry.
  🟡 if the code is otherwise sound.

### 8. Keep CI green

`biome check src test` (lint), `tsc --noEmit` (typecheck), `bun test`, and `tsdown` (build) must all
pass. Flag changes that obviously break one — a new export with no type, a test left failing, an API
rename not propagated. See `.github/workflows/ci.yml`.
