# Issue 5806 verification

Explicit ULW activation now persists in a per-hook, 256-session bounded set.
Existing detector guards still apply. Deletion, disposal and the shared
stop-continuation owner clear activation; the model resolver remains pure.

## Checks

- Before the fix: 3 pass / 3 fail; a keyword-free follow-up had `active: false`
  and `override: null`. The added common-stop case separately failed once.
- `bun test packages/omo-opencode/src/hooks/keyword-detector packages/omo-opencode/src/plugin/chat-message.test.ts`: 135 pass, 0 fail.
- `bun test packages/omo-opencode/src/plugin/stop-continuation-entrypoints.test.ts packages/omo-opencode/src/plugin/command-execute-before.test.ts packages/omo-opencode/src/plugin/tool-execute-before.test.ts`: 28 pass, 0 fail.
- Review regression: deletion through the production event dispatcher failed
  before its keyword-detector route was added. The keyword/event suites then
  passed 162 tests across 18 files.
- Bun 1.4.0: `bun run typecheck` and `bun run build` both exited 0.
  Final build output: `build: all steps completed`.
- Initial worktree setup denied local submodule-cache transport; scoped Git
  submodule initialization repaired setup before the standard build passed.
- LSP diagnostics rejected the sibling worktree; the full compiler check above
  validated the actual changed source instead.

## Real harness capture

Real OpenCode 1.18.4 loaded a PluginModule wrapping the production keyword hook,
event dispatcher, pure model resolver and common stop owner. Two HTTP turns proved
activation and retention; the native command endpoint stopped continuation,
and a subsequent message stayed ordinary. SSE proved the matching events.
Only the model responses were scripted. A disposable ARM64 Docker container
mounted only synthetic QA artifacts, with private HOME/XDG roots and no host
configuration or database mounts. Server and container were removed. After
the stop check, the driver reactivated ULW before deleting the session;
`deletion.routed` and `deletion.cleared` prove the real dispatcher delivered
that event and removed active state.

## Reproduce and inspect

Prepare the `omo-qa` image using the repository's
[Docker QA setup](../../../.agents/skills/opencode-qa/references/docker-qa.md),
install repository dependencies, and select Bun 1.4.0 on PATH. From the root:

```sh
bash .omo/evidence/20260908-5806-ultrawork-followups/commands.sh
```

The committed [commands.sh](commands.sh), [adapter.ts](adapter.ts),
[build.ts](build.ts), and [run.mjs](run.mjs) are the actual replay files.
[result.json](result.json) is the exact structured capture.
[isolation.txt](isolation.txt) records the before/after
`SELECT count(*) FROM session` query against the host database resolved by
`opencode db path`; the replay asserts the counts are equal.

This covers the changed hook contract, not probabilistic model compliance or
full adapter bootstrap. The temporary bundle, raw prompts and unrelated logs
are omitted; no credentials or personal configuration were copied.
