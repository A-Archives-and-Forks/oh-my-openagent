# QA summary - PR #6611 review fix - model-less retry dedupe

Captured 2026-08-05 on Windows 11 with Bun 1.3.14 and Node v24.18.0.
OpenCode harness QA ran as the non-root `codexqa` user in Ubuntu 22.04 under
WSL2 with the native Linux OpenCode 1.18.13 binary.

## What was tested

1. A red-green regression test that sends the same retry status twice without
   model metadata while the first fallback mutates `currentModel`.
2. A red-green regression test that repeats one variant and then sends a
   different variant of the same provider/model.
3. The complete runtime-fallback test directory.
4. Repository typecheck and production build.
5. Direct Bun drivers importing the exported session-status handler and
   replaying the exact model-less duplicate sequence.
6. A real isolated OpenCode server loaded with this worktree's `dist/index.js`.
   The QA subscribed to `/event` before prompting and awaited a
   `session.status` event.

## What was observed

- Before the source fix, the regression test failed because the duplicate
  status aborted twice: 5 pass, 1 fail.
- After changing the missing-model key to the stable `unknown` sentinel, the
  targeted file passed: 6 pass, 0 fail.
- Before including variants, the second regression failed because low and
  high variants shared one key: 6 pass, 1 fail.
- After including the normalized variant, the targeted file passed:
  7 pass, 0 fail.
- The complete runtime-fallback suite passed: 254 pass, 0 fail.
- `bun run typecheck` and `bun run build` exited 0.
- The direct driver observed one abort, one fallback dispatch to
  `openai/gpt-5.4`, and a stable key beginning with `unknown:`.
- The variant driver observed two aborts and two fallback dispatches; the
  repeated low variant deduplicated while the high variant advanced.
- The real prompt returned HTTP 204.
- The SSE subscription observed `{"type":"session.status"}`.
- The loaded plugin list contained this worktree's `dist/index.js`.
- The real Linux OpenCode database contained 0 sessions before and after QA.

Exact concise captures:

- `red-green.txt`
- `verification.txt`
- `manual-qa.txt`
- `opencode-hook-qa.sh`
- `opencode.json`

## Why it is enough

The two red-green tests toggle both reviewer-reported failures directly. The
full hook suite covers adjacent retry, abort, watchdog, and cleanup behavior.
Typecheck and build validate the shipped TypeScript bundle. The direct driver
executes the changed module through its exported factory. The isolated real
OpenCode run proves the matching lifecycle event reaches the loaded plugin
surface while the host database remains unchanged.

## What was omitted

No credentials, tokens, authentication headers, environment dumps, session
payloads, or raw secret-bearing server logs were copied. Failed harness setup
attempts were omitted because they failed before behavior execution; the final
reviewer-readable driver records the successful isolated procedure.
