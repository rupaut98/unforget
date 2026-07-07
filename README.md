# unforget

**Re-inject the working state Claude Code loses when it compacts context.**

When Claude Code compacts a long conversation, it replaces the transcript with a short
summary. That summary is lossy: the file you were mid-edit on, the command that just failed,
the approach you already ruled out, the constraint you set 40 turns ago — gone from context.

`unforget` reads the transcript that Claude Code keeps on disk (append-only, it survives
compaction), figures out exactly what was dropped, and prints a compact markdown digest of the
working state so it can be fed straight back into the fresh context via a hook.

- **Zero runtime dependencies.** Reads your transcripts locally. Never makes a network call.
- **Reads only your own machine**, under `~/.claude` (or `$CLAUDE_CONFIG_DIR`).
- **Silent when there's nothing to recover** — safe to wire to a hook.

## Install

```sh
npm install -g unforget   # or: bunx unforget / npx unforget
```

## Use

Automatic — add the hook so every post-compaction session starts with the digest re-injected:

```sh
unforget init           # shows the exact settings.json change, asks, backs up, then writes
unforget init --remove  # uninstall
unforget init --yes     # skip the confirmation prompt
unforget init --print   # just print the hooks block to add by hand
```

That registers a `SessionStart` hook (matcher `compact`) running `unforget inject`, written with
absolute paths so it still fires when Claude Code is launched from a GUI app with a minimal
`PATH`. `init` resolves symlinks and writes through them (dotfiles-managed settings stay
symlinked), and refuses to touch a settings file it can't parse.

Manual — inspect what a compaction dropped:

```sh
unforget digest                       # digest for the newest transcript in the current project
unforget digest --boundary 2          # the 2nd-from-last compaction instead of the last
unforget digest --transcript path.jsonl --json
```

## How it works

1. **Locate** the newest transcript for the current project (`--session <id>` / `--transcript <path>`
   to override). Project dir is `~/.claude/projects/<cwd with `/` and `.` → `-`>/`.
2. **Boundary.** Find the last `compact_boundary` record and read its `preservedMessages` — the set
   of message UUIDs that survived into the new context.
3. **Dropped set.** Everything between the *previous* boundary and this one whose UUID was not
   preserved. (Windowing from the previous boundary, not the file start, is deliberate — records
   before it were already summarized once and re-surfacing them is noise, not lost state.)
4. **Extract** a deterministic digest from the dropped records only:
   - **Active task** — the most recent substantial user ask. Chat filler ("full path", "ok
     continue"), interruption markers, cross-session notifications, pasted terminal output,
     and pasted status reports are filtered out first; validated against real compaction
     boundaries.
   - **In-flight edits** — files touched by `Edit`/`Write`, with edit counts.
   - **Commands & outcomes** — `Bash` command failures and the latest test result. Successful
     commands stay in `digest --json` but are not injected: on real boundaries they were 89% of
     items and almost never useful.
   - **Dead-ends** — commands that failed 2+ times with the same prefix, and files whose edits
     were followed by a failure and a switch to another file (possibly unfinished).
   - **Constraints** — "don't / never / must not / always …" sentences from your messages.
   - **Next step** — the last thing the assistant said it would do.
5. **Dedupe** against the built-in compact summary: anything the summary already carries is
   dropped, so only what was genuinely lost gets re-injected. The summary is read purely as an
   exclusion filter, never as a content source.
6. **Render** markdown, empty sections omitted, hard-capped at 9,500 characters (oldest items
   trimmed first).

One asymmetry: Claude Code flushes the new boundary (and summary) to disk only *after*
SessionStart hooks run. So the hook path (`inject`) windows from the last *flushed* boundary to
end-of-file — the exact window that was just compacted — with the same extraction and no summary
to dedupe against yet. The boundary-diff steps above are what `unforget digest` sees after the
fact.

## Privacy

`unforget` reads message content because reconstructing working state *is* the product — but it
only ever reads files under your own `~/.claude`, writes nothing outside its own config, and makes
no network calls. Nothing leaves your machine.

## Development

```sh
bun test          # tests
bunx tsc --noEmit # typecheck
biome check src test
bun run build     # tsdown → dist/cli.mjs
```

MIT
