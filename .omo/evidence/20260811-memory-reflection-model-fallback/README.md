# Memory reflection executable and model fallback QA

Date: 2026-08-11
Branch: `feat/memory-v2-active-learning`

## What was tested

### Restricted-PATH Senpi executable resolution

The resolver was executed with a PATH containing Node but no Senpi bin directory, then the resolved
command was launched with `--version`.

Observed:

```json
{
  "path": "/opt/homebrew/bin",
  "command": "/Volumes/mengmotaStorage/local-workspaces/omo-wt/feat/memory-v2-active-learning/packages/omo-senpi/node_modules/@code-yeongyu/senpi/dist/cli.js",
  "status": 0,
  "stdout": "2026.8.11-2",
  "stderr": ""
}
```

This reproduces the environment behind
`sandbox-exec: execvp() of 'senpi' failed: No such file or directory` without depending on the
user's PATH, and proves the replacement command is executable.

### Failing-first and mutation-checked fallback behavior

The reflection integration test exposed an extension-only primary and a child-visible fallback.
Before the retry implementation it failed:

```text
Expected: "merged"
Received: "failed"
```

After implementation, the real supervisor integration passed and recorded:

```text
attempts: extension-only/primary, kimi-coding/fallback
completion model: kimi-coding/fallback
outcome: merged
```

Temporarily disabling fallback detection made the same test fail again with `failed`, proving the
test is sensitive to the fix.

The corresponding facts extraction integration also failed first with `failed` and then passed with
the ordered attempts:

```text
extension-only/primary
omo-mock/mock-1
```

### Live Senpi model fallback through the shipped extension

Command:

```text
SENPI_BIN=/Users/yeongyu/.local/bin/senpi \
  bun packages/omo-senpi/scripts/qa/memory-model-fallback-e2e.mjs
```

The driver used:

- a real Senpi parent process,
- the rebuilt git-tracked `plugin/extensions/omo.js`,
- isolated `SENPI_CODING_AGENT_DIR`, session directory, XDG config, and `OMO_MEMORY_HOME`,
- a parent-visible model absent from the clean `--no-extensions` child,
- a child-visible mock fallback provider,
- an event subscription that kept print-mode Senpi alive until reflection completion.

Observed:

```json
{
  "result": "PASS",
  "attempts": [
    "extension-only/primary",
    "omo-mock/mock-1"
  ],
  "outcome": "merged",
  "model": "omo-mock/mock-1"
}
```

The merged memory document contained the fallback reflection sentinel.

### Host config repair

`~/.omo/omo.jsonc` previously pinned `categories.quick.models` to Apitopia and Quotio models that a
clean reflection child could not see. The stale model array was removed while preserving
`prompt_append` and `reasoning`.

The real unified config loader reported:

```json
{
  "diagnostics": [],
  "quick": {
    "reasoning": "off",
    "promptAppend": "string"
  }
}
```

`quick.model` and `quick.models` are both absent, so the child-visible builtin quick chain is used.

### Automated verification

- `bun test packages/omo-senpi/src/components/memory/`
  - final post-review run: 451 passed, 0 failed, 1318 assertions
- `bun run --cwd packages/omo-senpi typecheck`
  - passed
- focused fallback tests
  - canonical stale-registry resolution: passed
  - reflection supervisor fallback: passed
  - facts supervisor fallback: passed
  - retry helper exact-error/generic-error/timeout cases: passed
- `git diff --check`
  - passed
- debug-artifact scan
  - no trace sentinels or debugger statements remained
- pure LOC
  - `facts-runner.ts`: 247
  - `runner.ts`: 249
  - `resolve-model.ts`: 149
  - `memory-model-fallback-e2e.mjs`: 238

## Post-review hardening

Fresh goal, quality, and context reviewers found three gaps in the first fallback implementation:

1. Retry attempts reused one run directory without a durable attempt generation, so reconciliation
   could consume an earlier retryable outcome while a later child was live.
2. Each attempt reset the full timeout instead of sharing one absolute run deadline, and crash
   recovery did not persist the model that actually completed.
3. The PATH-independent resolver returned a path string rather than a cross-platform launcher
   descriptor, and first-turn recovery omitted legacy `model + fallback_models`.

The repaired protocol now persists `attempt`, `model`, `thinking`, `launching`, and one
`hardDeadlineAt` before each child launch. `outcome.json` carries the attempt, and both reflection
and facts reconciliation ignore outcomes whose attempt does not match the current ledger.
The supervisor clears `launching` when it records process ownership. Crash recovery reads the
persisted model and thinking into the completion record.

Failing-first and mutation evidence:

- A live attempt-2 ledger plus stale attempt-1 outcome previously finalized as failed; now
  reconciliation returns active and preserves the worktree.
- A pre-supervisor `launching: true` attempt previously finalized as failed; now it remains active
  until the shared hard deadline.
- Facts reconciliation previously tried to finalize the stale outcome; now it leaves the retry
  active without a warning.
- Forcing `runOutcomeMatchesLedger()` to return true made both reflection and facts stale-outcome
  tests fail. Restoring attempt equality made them green.
- Legacy `model + fallback_models` with a stale availability snapshot previously returned an empty
  fallback list; it now preserves the configured fallback through `registry.find()`.

Cross-platform launch evidence:

- Windows npm shim: `{ command: node.exe, prefixArgs: [dist/cli.js] }`.
- No executable but installed CLI: current interpreter plus `dist/cli.js`.
- Script-hosted current process: current interpreter plus its existing CLI entry script.
- Real restricted PATH with Node but no Senpi bin: the descriptor executed `senpi --version`
  successfully.

## Startup skill warnings

The memory `resources_discover` handler previously contributed `<memory repo>/skills` before that
directory existed, intentionally causing Senpi's visible `skill path does not exist` diagnostic.
The handler now contributes nothing until the directory exists; startup/reload discovers it after a
skill is committed.

The `frontend` collision came from two scanned files declaring `name: frontend`:

- current: `~/.bun/install/global/node_modules/omo-ai/plugin/skills/frontend/SKILL.md`
- stale user copy: `~/.agents/skills/omo-frontend/SKILL.md`

The stale copy was preserved outside scanned roots at:
`~/.agents/skills-disabled/omo-frontend-20260811`.

Exact Senpi loader proof:

- loading current + backed-up stale file produced `name "frontend" collision`;
- loading the current file alone produced zero diagnostics.

Real rebuilt-Omo startup:

```json
{
  "result": "PASS",
  "exit": 0,
  "missingSkillPathWarning": false,
  "frontendCollision": false,
  "skillsPathExists": false
}
```

Captured artifacts:

- `model-fallback-final.log`
- `skill-startup-final.log`
- `final-suite.log`

## Why this is enough

The evidence covers both user-reported failure modes at their real boundaries:

1. Senpi executable resolution no longer depends on PATH and was executed successfully.
2. A parent-visible model missing from the clean child now falls through to the next resolved model,
   for both reflection and facts extraction.

Unit tests pin the narrow retry predicate, supervisor integrations exercise real child processes and
git finalization, and the live E2E proves the rebuilt extension performs both attempts and merges the
fallback result in an isolated real Senpi process.

## What was omitted

- No credentials, auth files, provider tokens, environment dumps, or private prompt content were
  copied into this evidence.
- Temporary sandboxes and debug traces are removed during cleanup after the final gate.
