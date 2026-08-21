# BTW PR Review Follow-up QA

## What was tested

- Deferred `session.list` while the user replaced bare `/btw` with a newer
  composer draft.
- `New BTW` selection after navigation moved away from the picker source.
- Escape presses outside and inside the one-second pair interval using an
  injected clock.
- Real OpenCode 1.18.18 TUI against the task-worktree build, isolated XDG
  directories, and a local fake OpenAI Responses server.
- A real Main prompt, one retained BTW side, and two Escape presses 500 ms
  apart.
- Isolated SQLite session metadata and host OpenCode database counts.

## Commands

```text
bun test ./packages/omo-opencode/src/features/btw-side
bun test ./script/web-terminal-visual-qa.test.ts
bun run typecheck
bun run build
node script/qa/web-terminal-visual-qa.mjs [isolated OpenCode command and inputs]
sqlite3 [isolated opencode.db] [session metadata query]
sqlite3 [host opencode.db] "SELECT count(*) FROM session;"
```

## Real artifact

`committed/esc-window/terminal-excerpt.txt` is the sanitized xterm.js capture
excerpt.
