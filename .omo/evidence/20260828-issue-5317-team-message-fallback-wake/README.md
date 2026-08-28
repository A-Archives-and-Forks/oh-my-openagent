# Issue 5317: team mailbox fallback wake
## What was tested
- Deterministic prompt-gate fallback and mailbox injection.
- Focused and related tests, typecheck, and build.
- Disposable OpenCode 1.18.4 with the local bundle and team mode.
## What was observed
- RED: timed out waiting for the queued fallback wake.
- GREEN: focused 34/34, related 62/62, typecheck/build pass.
- Real server: healthy; `team_create` and `team_send_message` registered; SSE
  connected; host sessions unchanged at 7928.
- Captured outputs: `artifacts/failing-first.txt`,
  `artifacts/focused-tests.txt`, `artifacts/related-tests.txt`,
  `artifacts/typecheck-build.txt`, `artifacts/real-opencode.txt`, and
  `artifacts/real-fallback-run.txt`.

## Why it is enough

The regression covers the failed reservation-to-wake transition. Related tests
cover prompt-route invariants, and Docker proves the shipped tool surface.

## What was omitted

- Credentials, host config, headers, and raw logs.
- A provider turn; the deterministic race is covered at the module seam.
- The full suite had unrelated OAuth callback failures, so scoped gates are
  recorded instead.
