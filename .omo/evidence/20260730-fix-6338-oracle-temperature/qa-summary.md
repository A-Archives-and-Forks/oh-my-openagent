# QA summary - issue #6338 - strip unsupported agent temperature

Captured 2026-07-30 on Windows 11, bun 1.3.14, opencode 1.18.9.

## What was tested

- Regression tests:
  `bun test packages/model-core/src/model-settings-compatibility.test.ts packages/omo-opencode/src/plugin-handlers/agent-config-finalizer.test.ts`
- Typecheck:
  `bun run typecheck`
- Live OpenCode surface: isolated `opencode debug config` with Oracle configured as `anthropic/claude-opus-4-8`.

## What was observed

- Before fix: the two new regression tests failed because both model-core
  compatibility and OpenCode agent finalization kept `temperature: 0.1` for
  `anthropic/claude-opus-4-8` (`70 pass, 2 fail`).
- After fix: targeted tests passed (`72 pass, 0 fail, 178 assertions`) and
  `bun run typecheck` exited 0.
- Live OpenCode config after rebase: `oracle_model=anthropic/claude-opus-4-8`,
  `oracle_temperature_present=false`, `oracle_temperature=(unset)`.
- Isolation proof from the same run:
  - `data/config/cache/state/tmp` all resolved under
    `C:\Users\pss\AppData\Local\Temp\omo-6338-JiKzz2\...`
  - real OpenCode DB session count stayed `2818 -> 2818`.
- The 2026-07-31 reviewer rerun also covered all supported o-series reasoning
  suffixes and custom agent ordering. It passed 76 focused tests, both package
  typechecks, and the real OpenCode driver with
  `atlas_temperature_present=false` and `configured_order_preserved=true`.
  The real session count again stayed `2818 -> 2818`. See
  `review-rerun-20260731.txt`.

## Why it is enough

The unit tests pin the central model-settings compatibility rule and the OpenCode
agent finalization surface that previously leaked hardcoded sampling params. The
live OpenCode run proves the real plugin config path no longer sends
`temperature` for Claude Opus 4.8 and that the run used only sandboxed OpenCode
state.

## What was omitted

No secrets, auth headers, provider tokens, or environment dumps were recorded.
