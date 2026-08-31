# Memory delegation lifecycle evidence

Branch: `fix/mem-delegation-lifecycle`

## Initial RED

- Fix 1: unbounded `reserveSubagentSpawn` accepted unlimited descendants.
- Fix 2: sync delegation bypassed `ConcurrencyManager`.
- Fix 3: sync polling fetched the entire transcript every tick.
- Fix 4: delegated sessions were aborted but not deleted and lifecycle sets did not fully drain.

## Regression RED and GREEN

### B1 - continuation message-ID anchor

- RED: a newest-100 transcript page with a full-transcript count anchor (>=100) never passed the count gate, so continuation completion could starve forever.
- GREEN: continuation records `anchorMessageID` from the newest full-transcript message and the poller accepts a bounded page when it contains messages after that ID. Full remote suite passed.

### B2 - nested sync concurrency reentrancy

- RED: a nested sync delegation under `defaultConcurrency: 1` waited on the parent-held slot.
- GREEN: only root-level sync delegations acquire the gate; nested sync delegations rely on the root slot and descendant guard. Full remote suite passed.

### B3 - revival-safe deletion timers

- RED: an untracked completion deletion timer could delete a revived live continuation at the original deadline.
- GREEN: deletion timers are tracked by session ID; continuation start cancels the pending timer and completion schedules a fresh grace-period deletion. Full remote suite passed.

### Remote GREEN

Required command:

```text
MAC_TEST_TIMEOUT_S=2700 bun /tmp/omo-mac-test2.mjs fix/mem-delegation-lifecycle -- packages/omo-opencode/src/features/background-agent packages/omo-opencode/src/tools/delegate-task
```

Result:

```text
1230 pass
0 fail
3022 expect() calls
Ran 1230 tests across 101 files
```

## Final design notes

- `background_task.maxLiveDescendantsPerRoot` defaults to `24`, intentionally above the `ConcurrencyManager` scheduler so legitimate tasks queue rather than fail. `0` disables the guard.
- Sync session deletion follows `TASK_CLEANUP_DELAY_MS` to preserve full-session read-back and continuation grace windows.
- Parent wake inspection has no cross-check transcript cache; each distinct wake check observes fresh history. Transcript reads remain bounded where the new polling path uses `limit: 100`.
- Existing tests were left unmodified.
