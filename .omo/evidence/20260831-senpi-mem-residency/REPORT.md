# senpi-task residency retention evidence

## Scope

Branch: `fix/senpi-mem-task-residency`  
Base: `origin/dev` at `d50518d45`  
Commits: `e7768de54`, `3fa909e17`, `cd157168d`

## Fixes

1. **Idle resident reclamation (3.1):** terminal residents owned by this process (or backed by a local live handle) are evicted after `15 minutes` without an `updated_at` touch. The choice is shorter than the existing `24 hour` record TTL so the durable record remains available to `task_output` while the large in-process `AgentSession` is released. An unref'd 15-minute sweep also invokes `cleanupExpiredRecords`; its returned disposer is called during `session_shutdown`. Candidates are re-read immediately before teardown and pending sends are skipped.
2. **Bounded default (3.2):** default residency is now `min(16, max(8, parallelism * 2))`; parallelism 14 resolves to 16 rather than 42. Per-process counting is not changed: the existing lifecycle is composed per session and no host-wide shared residency registry seam exists. This is documented as follow-up.
3. **Pending sends (3.5):** the steering engine now tracks in-flight steer/revive operations and exposes them together with durable `pending_steering`. The manager and omo-senpi residency bridge use that state for eviction checks.

## TDD evidence

- **RED:** the first test commit (`e7768de54`) added the regression coverage before implementation. The idle test captured the pre-fix behavior (terminal resident remained `resident` and undisposed), the config test captured the old parallelism-14 result of 42, and the adapter test required `hasPendingSends === true` for a queued message while the bridge returned the hard-coded false.
- **GREEN:** implementation commit (`3fa909e17`) changes the idle test to assert eviction/disposal and the config assertion to 16. The bundle check passed against the regenerated artifacts.
- The initial macOS harness attempt was blocked because `/tmp/omo-mac-test2.mjs` was absent. After the harness was recreated, the prescribed command completed successfully:

  `MAC_TEST_TIMEOUT_S=2400 bun /tmp/omo-mac-test2.mjs fix/senpi-mem-task-residency -- packages/senpi-task`

  Result: **1773 passed, 1 skipped, 0 failed** across 252 files; exit 0. Local Bun tests were not run, as forbidden by task scope.

## Bundle verification

`bun install` completed with Bun 1.4.0.  
`node packages/omo-senpi/plugin/scripts/build-extension.mjs --check` passed after bundle regeneration. Tracked `omo.js` and `omo-task.js` artifacts are included in commit `cd157168d`.

## Explicit follow-ups

- Matrix/Lane 3.3: wire DAG pruning and cache run listings.
- Matrix/Lane 3.4: reduce snapshot fan-out serialization churn.
- Matrix/Lane 3.6: sweep orphaned omo-family processes.
- Suspect #4: remove or cap curated-agent in-process pinning.
- Introduce a host-owned process-wide residency registry/cap for multi-session hosts.

## Working tree / remote

The worktree is clean after push. Branch push succeeded to `origin/fix/senpi-mem-task-residency`. PR is open and the prescribed remote macOS test is green.
