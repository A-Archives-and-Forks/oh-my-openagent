# RED -> GREEN - per-file test budgets on slow runners

## Correction

An earlier revision of this document claimed `setDefaultTimeout` was process-global and that PR #6713
lowered it on POSIX. **That was wrong**, and the corrected mechanism is below. The claim was disproven by
direct experiment rather than argument.

## The decisive experiment

Two throwaway files run in one `bun test` invocation:

- `a-raises.test.ts` calls `setDefaultTimeout(60_000)` and holds a fast test.
- `b-slow.test.ts` sets no budget and awaits 6s.

```text
(pass) a fast test in the raising file [3.57ms]
(fail) b slow test in a file with no budget [5002.23ms]
  ^ this test timed out after 5000ms.
```

`setDefaultTimeout` is therefore **per-file**: one file can never raise or lower another file's budget.
The probe was deleted after the run.

## What that proves about PR #6713

1. The `test-setup.ts` win32 floor could never apply to any test file, because the preload declares no
   tests. It was dead code implying protection it did not provide, so it is removed here.
2. The four per-file budgets #6713 added were correct and are **restored**; removing them was the wrong
   inference.
3. The two CI failures were independent suites that simply have no budget of their own:
   - `prompt-async-route-audit.test.ts` timed out on macOS - it parses the entire production source set
     through the TypeScript native API.
     https://github.com/code-yeongyu/oh-my-openagent/actions/runs/31385635588/job/93445296099
   - `memory-apply-patch.test.ts` timed out twice on Windows - it drives real git repositories.
     https://github.com/code-yeongyu/oh-my-openagent/actions/runs/31387467844/job/93451057786

## Fix

Give each of those two suites its own budget, and delete the no-op floor. No assertion, fixture or
production path changes.

## GREEN (local)

```text
Ran 27 tests across 4 files. 27 pass, 0 fail
```

covering both newly budgeted suites plus two of the suites whose budgets were restored.

## Why this is enough

The mechanism is established by direct experiment rather than inference, each failing suite now owns the
budget it needs, and no file can affect another file's budget. CI remains the deciding surface.
