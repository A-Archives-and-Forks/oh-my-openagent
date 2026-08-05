# tool-pair-validator: operate on OpenCode's real Part model

Issue: https://github.com/code-yeongyu/oh-my-openagent/issues/6605
Date: 2026-08-05
Change scope: `packages/omo-opencode/src/hooks/tool-pair-validator/` (+ the two
`packages/omo-opencode/src/plugin/messages-transform.test.ts` cases that asserted the old shape).

## WHAT WAS TESTED

1. **Unit, failing-first.** New tests run against the OLD implementation (source files stashed,
   tests kept) to prove they actually catch the defect. Artifact: `unit-red-before-fix.txt`.
2. **Unit, green.** Same tests against the new implementation, plus the surrounding blast radius.
3. **Real OpenCode, isolated.** Built the plugin from this worktree, loaded it into a real
   `opencode` 1.18.13 run inside an isolated XDG sandbox, and drove two prompts:
   a healthy run (all tool parts terminal) and a run over a session containing a real
   `running` tool part. Artifact: `opencode-qa-plugin.log`, transcript below.

## WHAT WAS OBSERVED

### 1. Failing-first (old code, new tests)

```
(fail) conversion invariant > an assistant turn with a stuck tool part
  expect(findOrphanedToolCalls(convertToModelMessages(messages))).toEqual([])
  - []
  + [ "toolu_stuck" ]

(fail) conversion invariant > it added no part type that the conversion would discard
  expect(collectForeignPartTypes(messages)).toEqual([])
  - []
  + [ "tool_result" ]

 1 pass  3 fail
```

The old hook leaves the orphan in place AND injects a `tool_result` part, a type that is not in
OpenCode's `Part` union, so `MessageV2.toModelMessagesEffect` discards it before the request is built.

### 2. Green (new code)

```
bun test packages/omo-opencode/src/hooks/tool-pair-validator packages/omo-opencode/src/plugin/messages-transform.test.ts
  31 pass  0 fail  76 expect() calls

bun test packages/omo-opencode/src/hooks packages/omo-opencode/src/plugin
  2688 pass  0 fail  6168 expect() calls  (340 files)

bun run typecheck    -> exit 0
bun build packages/omo-opencode/src/index.ts --outdir dist --target bun --format esm --external zod -> exit 0
```

`bun run build` (the full graph) fails on this Windows host inside the vendored
`packages/lsp-tools-mcp` build (`'rm' is not recognized`). That is pre-existing and unrelated to
this change; the plugin bundle step was run directly and succeeds.

### 3. Real OpenCode, isolated sandbox

Sandbox: `XDG_DATA_HOME` / `XDG_CONFIG_HOME` / `XDG_STATE_HOME` / `XDG_CACHE_HOME` and `TMP`/`TEMP`
all pointed at `%TEMP%\omo-qa-sandbox`. Only `auth.json` was copied in (credentials are config, not
session state). Plugin registered by absolute path in the sandbox `opencode.json`.

**Run A - healthy session.** `opencode run "Use the bash tool to run: echo omo-qa-probe ..." --format json`

```
{"type":"tool_use", ... "state":{"status":"completed","input":{"command":"echo omo-qa-probe"},"output":"omo-qa-probe\r\n", ...}}
{"type":"text", ... "text":"DONE"}
OPENCODE_EXIT=0
```

`[tool-pair-validator]` lines in the plugin log after Run A: **0**. Correct: every tool part was
terminal, so the hook is a no-op and adds nothing to the request.

**Run B - session containing a real non-terminal tool part.** The completed tool part
`prt_fd076b18c001JQqkhfjEPYLQlh` (callID `call_00_p1uAgdhIpxlkWpaFBKx72999`) was rewritten in the
SANDBOX database to `state.status = "running"`, removing the source of its `tool_result`. Then the
same session was continued:

```
opencode run "Reply with exactly OK." --model opencode/deepseek-v4-flash-free --session ses_02f898812ffebRNU8h8WGx6Hkz
{"type":"text", ... "text":"OK"}
OPENCODE_EXIT=0
```

Plugin log:

```
[2026-08-05T05:49:43.629Z] [tool-pair-validator] Settled unpaired tool parts into a terminal error state
  {"assistantMessageID":"msg_fd0767cea001yeEqWlzEoLEZYK",
   "repairedToolCallIDs":["call_00_p1uAgdhIpxlkWpaFBKx72999"],
   "previousStatuses":["running"]}
```

The hook recognised a REAL OpenCode `tool` part (not the old `tool_use` shape), settled it, and the
request went through. Compare with the old implementation, which on the same class of input logged
`Repaired missing tool_result blocks` and changed nothing on the wire.

**Non-destructive:** the persisted part in the sandbox DB is still `running` after the run
(`SANDBOX_PERSISTED_TOOL_STATUS=running`). The hook only rewrites the per-request transform array
that OpenCode hands it, never stored session state.

### Isolation proof

```
REAL_DB_SESSIONS_BEFORE=2862
REAL_DB_SESSIONS_AFTER =2862
SANDBOX_SESSIONS=2
```

The real `~/.local/share/opencode/opencode.db` was never written to.

## WHY IT IS ENOUGH

- The failing-first run proves the new tests detect both halves of the defect: the surviving orphan
  and the discarded foreign part type. They cannot pass vacuously.
- The real-OpenCode run proves the rewritten hook fires against genuine `ToolPart` data produced by
  opencode itself, on the exact transform hook that OpenCode also invokes for compaction
  (`compaction.ts:350`), and that a request carrying a settled part succeeds.
- The no-op observation on the healthy run proves the hook does not perturb well-formed sessions.
- The unchanged persisted state proves no session corruption, which was the failure mode behind
  the earlier #3996 regression.

## WHAT WAS OMITTED

- `auth.json` was copied into the sandbox but is not reproduced here; no tokens, API keys, or auth
  headers appear in any artifact.
- `opencode-qa-plugin.log` is the sandbox-local plugin log only. It contains local filesystem paths
  and no credentials.
- The compaction 400 from issue #6605 is NOT claimed to be fixed by this change. Replaying the real
  session rows through `ai@5.0.226` `convertToModelMessages` produces a clean, fully paired array,
  so that particular orphan is introduced below the plugin's last hook point. This change makes the
  guard functional; it does not eliminate the upstream orphan.
