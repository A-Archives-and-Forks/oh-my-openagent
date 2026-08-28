# Issue 5317: team mailbox fallback wake

## What was tested

- A deterministic regression test reserved the recipient prompt gate, sent a
  team message to an idle member, observed live-delivery fallback, released the
  blocker, and awaited the queued wake event.
- The focused team messaging suite and related idle-wake and prompt-route
  suites were run.
- Root typecheck and build were run.
- A disposable Docker OpenCode server loaded the current local plugin bundle
  with team mode enabled. Its HTTP and SSE surfaces were queried.
- The host OpenCode session count was read before and after the final Docker
  run.

## What was observed

- Before the source change, the regression test timed out waiting for the
  queued fallback mailbox wake.
- After the source change, the focused suite passed 33/33 and the related suite
  passed 61/61.
- Typecheck and build completed successfully.
- OpenCode 1.18.4 reported healthy, loaded the local `dist/index.js`, registered
  `team_create` and `team_send_message`, and emitted `server.connected` on SSE.
- The host session count remained 7928 before and after the final run.

## Why it is enough

The regression test exercises the exact failed reservation-to-wake transition
and proves the unread mailbox message becomes injectable only after the queued
wake dispatches. Related tests cover existing reservation, idle-wake, and raw
prompt-route invariants. The Docker proof confirms the changed bundle loads
through real OpenCode and exposes the affected tool without touching host
session storage.

## What was omitted

- Provider credentials, host config contents, authorization headers, and raw
  server logs were not copied into evidence.
- A provider-backed agent turn was not needed for the deterministic gate race;
  the real server proof is limited to plugin loading, SSE, and tool
  registration.
- The repository-wide test process was not used as a gate because unrelated
  environment-dependent OAuth callback tests failed while the suite continued.
  Focused suites, typecheck, build, and the real OpenCode surface are recorded
  instead.
