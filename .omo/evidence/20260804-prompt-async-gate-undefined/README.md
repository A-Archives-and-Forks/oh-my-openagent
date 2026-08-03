# Evidence: prompt-async-gate compatibility fix for `got undefined` error message

Date: 2026-08-04
PR: https://github.com/code-yeongyu/oh-my-openagent/pull/6583
Issue: https://github.com/code-yeongyu/oh-my-openagent/issues/6582

## Root Cause
- In `packages/utils/src/prompt-async-gate.ts`, `isObjectPathTypeError(error)` strictly checked for `got object`.
- Node/Bun runtime type error messages when `path` is uninitialized or `undefined` produce: `"The 'path' property must be of type string, got undefined"`.
- `dispatchWithPathCompatibility` failed to handle `"got undefined"`, preventing retry/coercion to `input.path.id` and throwing the raw error during tool dispatch (`edit`/`task`).

## Verified Changes
1. `packages/utils/src/prompt-async-gate.ts`:
   Updated `isObjectPathTypeError` to accept both `"got object"` and `"got undefined"`.
2. Unit tests added and verified PASS:
   - `packages/utils/src/prompt-async-gate-path-compat.test.ts` (3 tests passed)
   - `packages/omo-opencode/src/shared/prompt-async-gate-path-compat.test.ts` (3 tests passed)

## QA Verification Proof
```bash
$ bun test src/prompt-async-gate-path-compat.test.ts (in packages/utils)
3 pass, 0 fail, 6 expect() calls

$ bun test src/shared/prompt-async-gate-path-compat.test.ts (in packages/omo-opencode)
3 pass, 0 fail, 6 expect() calls
```
