# Contributing

Thanks for helping out. unforget is a small, zero-runtime-dependency TypeScript CLI.

## Setup

```bash
bun install
bun run dev        # run against your own ~/.claude
```

## Before opening a PR

```bash
bun test
bun run lint
bun run typecheck
bun run build
```

All four must pass — CI runs the same.

## Ground rules

- Keep `dependencies` in `package.json` empty. Dev tooling stays in `devDependencies` (bundled at build).
- `inject` is a silent no-op on missing data or any error: print nothing, exit 0. A hook must never emit noise.
- No network, ever. Reads under `~/.claude` (or `$CLAUDE_CONFIG_DIR`) are read-only; we write only our own settings block, and only when the user opts in.
- Tolerant parsing: a bad JSONL line is skipped, a missing file yields empty, never a crash.
- Every extraction filter gets a row in `docs/HEURISTICS.md` (what it catches + the finding that motivated it).
- Keep changes small and focused; one concern per PR. Conventional-commit messages (`type(scope): …`).

See `CLAUDE.md` for the full invariants and module map.
