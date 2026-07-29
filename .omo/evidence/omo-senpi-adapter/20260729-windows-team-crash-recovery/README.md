# Windows Team startup and crash recovery hardening

## Scope

This evidence covers the Windows Team-mode launcher and restart-liveness fixes tracked by #6449.

The patch:

- resolves npm-installed `senpi` shims through `process.execPath` and the package CLI instead of asking Windows to execute `.cmd` wrappers directly;
- preserves direct spawning for native executables;
- rejects non-positive, non-integer, non-finite, and unsafe root PIDs before any process probe or termination side effect;
- terminates the exact validated process tree on Windows with `taskkill.exe /PID <pid> /T /F`;
- persists `notification.liveness_notified_epoch` in task records;
- acknowledges restart-liveness only after the matching structured `message_start`/`message_end` `deliveryKey` is observed;
- replays an unacknowledged liveness event after a lead restart;
- validates structured liveness events without accepting unrelated event payloads.

Base: `origin/dev` at `106bf0da14077e42e5e95cdd0ca0c27a86730bda`.

## Focused validation

- Seven focused test files: **83 passed / 0 failed**, 226 assertions.
- `packages/omo-senpi` typecheck: **PASS**.
- `packages/senpi-task` typecheck: **PASS**.
- Team QA self-test: **PASS**.
- Source-only added-line security scan: no credential assignment, `shell: true`, dynamic execution, image-name kill, `pkill`, or `killall` findings.
- `git diff --check`: **PASS**.

## Full upstream gate comparison

The Windows host cannot create the symlinks used by a set of cross-platform tests and also exposes pre-existing user-agent/config discovery to tests that do not isolate the home directory. The clean `origin/dev` worktree was built and tested on the same host to distinguish baseline failures from patch regressions.

| Gate | Clean `origin/dev` | Candidate | Result |
|---|---:|---:|---|
| `bun run typecheck` | not needed for comparison | exit 0 | PASS |
| `bun run build` | exit 0 | exit 0 | PASS |
| `bun test` | 12,267 pass / 73 fail / 22 skip | 12,287 pass / 73 fail / 22 skip | No increase in failures; 20 new passing tests |
| `bun run test:codex` | 359 pass / 28 fail / 7 skip | 359 pass / 28 fail / 7 skip | Exact baseline parity |

The remaining root and Codex failures are pre-existing on this Windows host. They are dominated by `EPERM` from symlink fixtures, checkout symlink materialization, home-directory contamination, and unrelated timeout-sensitive scans.

## Live Windows Team E2E

`node packages/omo-senpi/scripts/qa/team-e2e.mjs` ran against the built candidate with isolated mock credentials and state.

- Result: **PASS**.
- Checks: **13/13 true**.
- Crash occurred after member injection but before reservation commit.
- The exact member and parent process tree were terminated.
- Restart exited cleanly.
- Lead liveness was injected after restart.
- The observed liveness delivery persisted `liveness_notified_epoch` for the current run epoch.
- Real Senpi coding-agent directory remained unchanged.
- Credential isolation remained clean.
- Leaked child PIDs: **0**.

Sanitized structured results are in `team-e2e.json` and `crash-recovery.json`.

## Isolation

- No API keys, OAuth tokens, auth headers, environment dumps, private prompts, or transcripts are committed.
- Local absolute paths, host usernames, ephemeral UUIDs, and process IDs were removed from the structured evidence.
- The active installed Senpi plugin was not mutated during this PR validation.

## Residual delivery semantics

The liveness notification remains at-least-once across a crash between event delivery and durable acknowledgement. The patch closes deterministic loss after `sendMessage()` returns, but a sufficiently narrow crash window can still produce a duplicate replay. Downstream handling should remain idempotent.
