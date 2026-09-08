# Issue 5806 verification

Explicit ULW activation now persists in a per-hook, 256-session bounded set.
Existing detector guards still apply. Deletion, disposal and the shared
stop-continuation owner clear activation; the model resolver remains pure.

## Checks

- Before the fix: 3 pass / 3 fail; a keyword-free follow-up had `active: false`
  and `override: null`. The added common-stop case separately failed once.
- `bun test packages/omo-opencode/src/hooks/keyword-detector packages/omo-opencode/src/plugin/chat-message.test.ts`: 135 pass, 0 fail.
- `bun test packages/omo-opencode/src/plugin/stop-continuation-entrypoints.test.ts packages/omo-opencode/src/plugin/command-execute-before.test.ts packages/omo-opencode/src/plugin/tool-execute-before.test.ts`: 28 pass, 0 fail.
- Bun 1.4.0: `bun run typecheck` and `bun run build` both exited 0.
  Final build output: `build: all steps completed`.
- Initial worktree setup denied local submodule-cache transport; scoped Git
  submodule initialization repaired setup before the standard build passed.
- LSP diagnostics rejected the sibling worktree; the full compiler check above
  validated the actual changed source instead.

## Real harness capture

Real OpenCode 1.18.4 loaded a PluginModule wrapping the production keyword hook,
pure model resolver and common stop owner. Two HTTP message turns proved
activation and retention; the native command endpoint stopped continuation,
and a subsequent message stayed ordinary. SSE proved the matching events.
Only the model responses were scripted. A disposable ARM64 Docker container
mounted only synthetic QA artifacts, with private HOME/XDG roots and no host
configuration or database mounts. Server and container were removed.

```json
{"status":"PASS","opencode":"1.18.4","calls":[{"active":true,"override":{"providerID":"qa","modelID":"ulw-selected"}},{"active":true,"override":{"providerID":"qa","modelID":"ulw-selected"}},{"active":false,"override":null},{"active":false,"override":null}],"sse":["catalog.updated","command.executed","integration.updated","message.part.delta","message.part.updated","message.updated","plugin.added","reference.updated","server.connected","session.created","session.deleted","session.diff","session.idle","session.status","session.updated","tui.toast.show"],"modelCalls":4,"externalModelCalls":0,"isolation":"Disposable Docker; evidence-only mount; HOME/XDG under /qa","serverExited":true}
```

This covers the changed hook contract, not probabilistic model compliance or
full adapter bootstrap. Temporary drivers/bundles, raw prompts and unrelated
logs are omitted; no credentials or personal configuration were copied.
