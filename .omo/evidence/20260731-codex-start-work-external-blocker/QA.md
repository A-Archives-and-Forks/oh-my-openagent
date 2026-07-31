# QA: start-work Stop hook honors a conclusive external blocker

Fixes `code-yeongyu/lazycodex#144`. Scope: `packages/omo-codex/plugin/components/start-work-continuation/`.
Because the change lives under `packages/omo-codex/`, the Codex-side QA mandate applies: the real component CLI was
driven over stdin exactly the way Codex invokes the `Stop` hook, and the real `~/.codex` was proven untouched.

## What was tested

| # | Command / action | Surface driven | Behavior it proves |
|---|---|---|---|
| 1 | `npx vitest --run test/codex-hook.test.ts` | component unit seam (`runStopHook`) | New regression case fails before the fix (RED) |
| 2 | `npm run test` in the component | build + full component suite (3 files) | Fix flips RED to GREEN with no regression (GREEN) |
| 3 | `npx tsc --noEmit` in the component | TypeScript strict typecheck | No type regression |
| 4 | `cli-smoke.ps1` -> `node dist/cli.js hook stop < payload.json` | REAL built hook CLI over stdin | End-to-end hook behavior a Codex session would observe |
| 5 | `node --test packages/omo-codex/plugin/test/*.test.mjs` (50 files) | plugin aggregate suite | No cross-component regression |
| 6 | `bun run test:codex` | Codex compatibility gate | Gate status on this machine |

`cli-smoke.ps1` builds a throwaway workspace containing `.omo/boulder.json` (active work, `codex:smoke-session`) and a
two-task `.omo/plans/test.md`, then fires three payloads that differ ONLY in `last_assistant_message`:

- **A** ordinary answer -> continuation must still be injected
- **B** `<start-work-blocked-external>` as the entire first line -> the turn must be allowed to end
- **C** the same marker present but NOT on the first line -> continuation must still be injected (false-positive guard)

## What was observed

RED (`red-codex-hook.txt`), before any production change:

```
FAIL  test/codex-hook.test.ts > start-work Stop hook > #given active codex work and an external-blocker marker #when hook runs #then returns empty output
AssertionError: expected '{"decision":"block","reason":"<start-…' to be '' // Object.is equality
Tests  1 failed | 11 passed (12)
```

GREEN (`green-component-vitest.txt`): `Test Files 3 passed (3)` / `Tests 39 passed (39)`. Typecheck
(`typecheck-component.txt`): `tsc exit=0`.

Real hook CLI, before vs after. Only `src/codex-hook.ts` was stashed between the two runs, so the delta is attributable
to the fix alone (`cli-smoke-before-fix.txt`, `cli-smoke-after-fix.txt`):

| Case | Before fix | After fix |
|---|---|---|
| A ordinary answer | BLOCK (continuation injected), 9968 bytes | BLOCK (continuation injected), 9968 bytes |
| B marker on first line | BLOCK (continuation injected), 9968 bytes | **NO OUTPUT (Stop allowed), 0 bytes** |
| C marker below first line | BLOCK (continuation injected), 9968 bytes | BLOCK (continuation injected), 9968 bytes |

Case B is the bug and the fix. Cases A and C are byte-identical across both runs, so the continuation contract and the
false-positive guard are unchanged.

Isolation: the smoke script hashes the real `~/.codex/config.toml` before and after every run and reported
`unchanged: True` in both. The hook only reads the payload `cwd`; it never touches `CODEX_HOME`. The throwaway
workspace is deleted at the end of the script (`temp workspace removed: ...`), so no QA state is left behind.

Plugin aggregate suite (`plugin-aggregate-node-test.txt`): `tests 358 / pass 357 / fail 1`. The single failure is
`component-bundled-cli.test.mjs` in the **lsp** component, an `EPERM` while removing a Windows temp directory. It is a
Windows file-lock artifact in a component this change does not touch.

`bun run test:codex` (`test-codex-gate.txt`) halts on this machine inside the vendored `packages/lsp-tools-mcp` step
with two `test/process.test.ts` assertions that compare a bare `typescript-language-server.cmd` against the absolute
path resolved from this machine's global npm prefix. `preexisting-lsp-tools-mcp-failure.txt` reproduces the identical
two failures with ALL of `packages/omo-codex` stashed, which proves they are pre-existing and environment-driven rather
than caused by this change. The remaining Codex-gate steps that do cover this change were run individually and are
recorded above.

## Why it is enough

The defect is that `StopInput.last_assistant_message` was declared in `types.ts` and validated by `isStopInput()` while
`runStopHook()` never read it, so no answer the agent could write would ever end the turn. The evidence closes that at
both levels: the unit seam pins the decision function, and the built CLI proves the behavior a live Codex `Stop` hook
would actually produce. The before/after CLI runs cover the fix path, the untouched happy path, and the near-miss
false positive, and the two non-target cases are byte-identical across the change.

Residual risk: the marker is a plain-text contract between `directive.md` and the hook, so a model that ignores the
directive keeps the old (blocking) behavior. That is the safe direction of failure. A session already mid-flight on an
older directive is unaffected because an absent marker preserves the existing path exactly.

## What was omitted

No live Codex `app-server` session was driven, because this hook's decision depends only on the payload and the
workspace files, both of which the CLI smoke reproduces exactly. No secrets, tokens, credentials, auth headers, or env
dumps appear in these artifacts; the only recorded environment detail is the SHA-256 of the real
`~/.codex/config.toml`, used solely to prove it was not modified. Verbose logs were trimmed to their failure headers
and summaries, and each trimmed file says so on its first line.
