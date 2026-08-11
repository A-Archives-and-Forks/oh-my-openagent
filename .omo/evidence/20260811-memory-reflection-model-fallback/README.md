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
  - clean pre-evidence run: 443 passed, 0 failed, 1298 assertions
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
  - `facts-runner.ts`: 244
  - `runner.ts`: 247
  - `resolve-model.ts`: 141
  - `memory-model-fallback-e2e.mjs`: 240

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
