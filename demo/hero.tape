# Record with: vhs demo/hero.tape  ->  demo/hero.gif
# Shows the real hook command (`unforget inject`) recovering working state after a
# compaction. Seeds a throwaway CLAUDE_CONFIG_DIR so `inject` auto-locates the sample —
# no --transcript flag on screen, just the command the SessionStart hook actually runs.
Output demo/hero.gif

Set Shell bash
Set FontSize 13
Set Width 1180
Set Height 540
Set Padding 28
Set Theme "Dracula"

Hide
Type "export CLAUDE_CONFIG_DIR=$(mktemp -d); P=$CLAUDE_CONFIG_DIR/projects/$(pwd | sed 's#[/.]#-#g'); mkdir -p $P; cp demo/sample-transcript.jsonl $P/demo.jsonl; alias unforget='bun src/cli.ts'; clear"
Enter
Show

Type "# Claude Code just compacted this session — the last hour is gone from its context."
Enter
Sleep 1.8s
Type "unforget inject"
Sleep 700ms
Enter
Sleep 5s
Type "# unforget re-injected all of that — automatically, on every compaction. nothing to run."
Enter
Sleep 2.5s
