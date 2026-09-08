# Issue 6077 verification

The prior Windows reminder expressed a preference and fallback, but omitted
deferred discovery. The added sentence conditionally directs code-mode users
to discover the actual Git Bash names through `ALL_TOOLS` and `exec`.
The existing seven behavior cases now assert parsed hook fields, not prose.

## Checks

- Component `typecheck`, `build`, and `test`: exit 0; 7 pass, 0 fail.
- Node 24.18.0 / Bun 1.4.0: `bun run test:codex` exited 0, including
  97 LSP tests, 547 ULW-loop tests, and the final 486 Node tests.
- An initial run selected unintended Node 22.14.0 and failed JSON parsing in
  an unchanged ULW-loop CLI test. No assertion in that component was altered.
- The ignored component runtime was rebuilt. Unrelated generated installer
  version changes were excluded. LSP could not access the sibling worktree;
  compiler checks covered the actual source.

## Real Codex delivery

Codex 0.144.6 loaded the built component and unchanged hook registration in a
cache-only fixture. Native `exec_command` produced the real `Bash` PreToolUse
event. Matching first-party start/completion notifications, a successful
command, one marker and context delivery into the next model request passed.
Context delivery was compared with the built component's structured output,
not an authored wording literal. Only model responses were scripted.

```json
{"status":"PASS","codex":"codex-cli 0.144.6","hooks":[{"method":"hook/started","id":"pre-tool-use:0:/qa/codex/plugins/cache/qa/git-bash/1.0.0/hooks/hooks.json:qa_exec","eventName":"preToolUse","status":"running"},{"method":"hook/completed","id":"pre-tool-use:0:/qa/codex/plugins/cache/qa/git-bash/1.0.0/hooks/hooks.json:qa_exec","eventName":"preToolUse","status":"completed"}],"contextDelivered":true,"commandCompleted":true,"requests":2,"markerCount":1,"nativeWindowsTested":false,"deferredExecutionTested":false,"externalModelCalls":0,"appServerExited":true}
```

The disposable ARM64 container had networking disabled, private HOME/CODEX_HOME
under `/qa`, and only component/QA artifact mounts. No host credentials or
configuration were mounted; app-server and container exited. Windows guarding
used synthetic `OS=Windows_NT`; native Windows, model choice, and deferred
execution itself were not measured. Raw model requests and local drivers are
omitted; the capture above retains only the relevant machine fields.
