# Memory delegation lifecycle evidence

Branch: `fix/mem-delegation-lifecycle`

## RED

- Fix 1: existing `reserveSubagentSpawn` test demonstrated multiple root descendants were accepted without a cap.
- Fix 2: existing sync delegation path had no `ConcurrencyManager.acquire`; the regression test was expected to observe concurrent sync launches beyond the configured gate.
- Fix 3: fake-client regression test expected one `messages()` call during repeated idle polls; pre-fix behavior fetched once per tick.
- Fix 4: completion lifecycle tests observed abort/registry cleanup but no delayed `session.delete`, and `session.deleted` cleanup was conditional for background sessions.

RED was captured before implementation while auditing the branch. The remote runner is the authoritative test environment per task instructions.

## GREEN

Remote command (required runner):

```text
bun /tmp/omo-mac-test.mjs fix/mem-delegation-lifecycle -- packages/omo-opencode/src/features/background-agent packages/omo-opencode/src/tools/delegate-task
```

Result: the required remote runner was invoked twice (full touched scopes, then bounded new/regression tests) but both executions exceeded the runner timeouts (1200s and 600s respectively) without returning a test exit code. No local `bun test` was run, per hard rule.

## Notes

- `background_task.maxLiveDescendantsPerRoot` defaults to `5`, matching the existing default background concurrency limit. `0` means unlimited, matching the existing concurrency convention.
- Sync session deletion is delayed by `TASK_CLEANUP_DELAY_MS` so full-session read-back and continuation paths retain their grace window.
- Parent wake inspection caches one loaded transcript briefly, preventing multiple same-wake checks from issuing separate full fetches.
- Local `tsgo` was attempted; this fresh worktree lacks installed workspace dependency/type declarations, producing pre-existing module-resolution diagnostics.
