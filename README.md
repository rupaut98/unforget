# unforget

**Re-inject the working state Claude Code loses when it compacts context.**

[![npm version](https://img.shields.io/npm/v/unforget.svg)](https://www.npmjs.com/package/unforget)
[![npm downloads](https://img.shields.io/npm/dm/unforget.svg)](https://www.npmjs.com/package/unforget)
[![CI](https://github.com/rupaut98/unforget/actions/workflows/ci.yml/badge.svg)](https://github.com/rupaut98/unforget/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/npm/l/unforget.svg)](./LICENSE)
[![Zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](https://github.com/rupaut98/unforget/blob/main/package.json)

![unforget recovering working state after a compaction](https://raw.githubusercontent.com/rupaut98/unforget/main/demo/hero.gif)

When Claude Code compacts a long session it swaps the transcript for a short summary, and that
summary is lossy: the file you were mid-edit on, the command that just failed, the approach you
ruled out, the constraint you set 40 turns ago — gone.

`unforget` reads the on-disk transcript (append-only, survives compaction), works out exactly what
was dropped, and re-injects a compact digest of it through a `SessionStart` hook — so the fresh
context picks up where you left off.

- **Zero runtime dependencies.** Local only, never a network call.
- **Reads only `~/.claude`** (or `$CLAUDE_CONFIG_DIR`); writes nothing but its own hook config.
- **Silent when there's nothing to recover** — safe to wire to a hook.

## Install

```sh
npm install -g unforget   # or: bunx unforget / npx unforget
```

## Use

Add the hook once; every post-compaction session then starts with the digest re-injected:

```sh
unforget init           # shows the settings.json change, asks, backs up, then writes
unforget init --remove  # uninstall
unforget init --print   # print the hooks block instead of writing
```

It registers a `SessionStart` hook (matcher `compact`) with absolute paths, so it still fires when
Claude Code launches from a GUI app with a minimal `PATH`. Symlink-safe; refuses a settings file it
can't parse.

Inspect or verify by hand:

```sh
unforget digest    # what the newest compaction dropped (--boundary N, --transcript, --json)
unforget doctor    # hook installed? paths on disk? last injection fresh?
```

## Does it work?

The built-in summary already covers most mechanical rediscovery; unforget catches what it drops.
In the author's own dogfooding — 10 post-install compactions, self-measured:

- **0.70 vs 3.06** rediscoveries per compaction (files re-read / commands re-run that were already
  known) — roughly 4× fewer.
- **96%** of the working state the summary dropped was carried by the digest.
- **~1,100 tokens** of that state re-injected per compaction that needed it.

Small single-machine sample — directional, not a guarantee. Run `bun bench/retro.ts` against your
own `~/.claude` to measure it yourself.

## How it works

1. Find the newest transcript's last `compact_boundary`; read which message UUIDs survived.
2. Dropped set = messages since the *previous* boundary that weren't preserved.
3. Extract a deterministic digest from the dropped records: active task, in-flight edits, failed
   commands + last test result, dead-ends, constraints (`don't / always …`), next step.
4. Drop anything the built-in summary already carries (summary read as a filter, never a source).
5. Render markdown, empty sections omitted, capped at 9,500 characters.

Claude Code flushes the new boundary to disk only *after* hooks run, so the live hook (`inject`)
windows from the last flushed boundary to end-of-file — the just-compacted turns — while `digest`
reconstructs it after the fact. See [`docs/hook-contract.md`](docs/hook-contract.md).

## Privacy

Reconstructing working state means reading message content — but only under your own `~/.claude`,
writing nothing outside its own config, with no network calls. Nothing leaves your machine.

## Development

```sh
bun test && bunx tsc --noEmit && biome check src test && bun run build
```

MIT
