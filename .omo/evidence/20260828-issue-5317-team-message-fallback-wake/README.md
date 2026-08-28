# Issue 5317: team mailbox fallback wake
## What was tested
- Deterministic prompt-gate fallback and mailbox injection.
- Focused and related tests, typecheck, and build.
- Disposable OpenCode 1.18.4 with the local bundle and team mode.
## What was observed
- RED: timed out waiting for the queued fallback wake.
- REVIEW RED: the second delivery overlapped the accepted live prompt, and an
  acknowledged message still dispatched its queued fallback wake.
- GREEN: focused 38/38, related 66/66, prompt gate 66/66,
  typecheck/build pass.
- Real server: healthy; `team_create` and `team_send_message` registered; SSE
  connected; host sessions unchanged at 7928. The corrected run preserved the
  live-delivery hold and dispatched fallback only after the blocker expired.
- Captured outputs: `artifacts/failing-first.txt`,
  `artifacts/focused-tests.txt`, `artifacts/related-tests.txt`,
  `artifacts/typecheck-build.txt`, `artifacts/real-opencode.txt`, and
  `artifacts/real-fallback-run.txt`, `artifacts/prompt-gate-tests.txt`,
  `artifacts/ci-regressions.txt`, and `artifacts/review-correction-run.txt`.

## Why it is enough

The regressions cover the failed reservation-to-wake transition, preservation
of the accepted prompt hold, and cancellation after exact-message ack. Related
tests cover prompt-route invariants. Message-specific dedupe coverage proves
that acknowledging an older coalescible message does not strand a newer one.
Transient revalidation errors remain queued for retry instead of cancelling the
wake, while missing team state cancels the obsolete entry. Docker proves the
shipped tool surface.

## What was omitted

- Credentials, host config, headers, and full secret-bearing logs.
- A provider turn; the deterministic race is covered at the module seam.
- The full suite had unrelated OAuth callback failures, so scoped gates are
  recorded instead.
