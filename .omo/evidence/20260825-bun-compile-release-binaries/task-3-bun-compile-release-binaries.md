# Task 3 - darwin-arm64 bare binary live-drive evidence

## WHAT WAS TESTED

Attempted the approved real-binary end-to-end drive in the task worktree `/tmp/work-binary-assets` on 2026-08-25:

```sh
bun run script/build-omo-binary.ts \
  --target darwin-arm64 \
  --omo-version 0.0.0-plan \
  --omo-ai-version 0.0.0-0.plan
```

The build completed successfully and emitted:

```text
built darwin-arm64: /private/tmp/work-binary-assets/dist/release-binaries/omo-darwin-arm64 (111765538 bytes, 1158 embedded sidecar files)
```

The binary was copied to a fresh download directory and invoked with all required isolation variables set to fresh directories:

```sh
HOME=/tmp/task3-20260825/home
XDG_CONFIG_HOME=/tmp/task3-20260825/config
XDG_DATA_HOME=/tmp/task3-20260825/data
XDG_STATE_HOME=/tmp/task3-20260825/state
XDG_CACHE_HOME=/tmp/task3-20260825/cache
OMO_CODING_AGENT_DIR=/tmp/task3-20260825/agent
/tmp/task3-20260825/download/omo-darwin-arm64 --version
```

## OBSERVED OUTPUT (RED before / live binary)

Both first and second `--version` executions exited 1 with empty stdout. Exact stderr from each run:

```text
706116 |     return;
706117 |   }
706118 |   const manifestFile = embedded.find((file) => file.name.endsWith("runtime-manifest.json"));
706119 |   if (!manifestFile)
706120 |     throw new Error("embedded runtime-manifest.json is missing");
706121 |   const expected = join128(homedir31(), ".omo", "binary-runtime", manifest.omoAiVersion, "omo");
                                   ^
TypeError: The "paths[3]" property must be of type string, got undefined
 code: "ERR_INVALID_ARG_TYPE"

      at main2 (/$bunfs/root/omo-darwin-arm64:706121:27)

Bun v1.4.0-canary.1+b58cd4685 (macOS arm64)
```

The isolated runtime directory was not created:

```text
find: /tmp/task3-20260825/home/.omo/binary-runtime/0.0.0-0.plan: No such file or directory
```

Inspection of the compiled binary confirms the failure mechanism: the embedded payload includes Senpi’s unrelated `runtime/lsp-daemon/dist/.omo-runtime-manifest.json`, and the compile entry uses `embedded.find((file) => file.name.endsWith("runtime-manifest.json"))`. That predicate can select the unrelated manifest before the required top-level `omo-runtime/runtime-manifest.json`; the selected JSON has no `omoAiVersion`, producing the exact `path.join` error above.

## SCENARIO RESULTS

| Scenario | Result | Evidence |
| --- | --- | --- |
| (a) first-run self-provisioning, exact stamped version, second-run consistency | BLOCKED before provisioning | Both invocations exit 1; no isolated runtime directory exists. |
| (b) `doctor` / setup report and engine pin | NOT RUN | Scenario (a) reveals a pre-provisioning launcher defect; running further commands cannot establish the required provisioned-path proof. |
| (c) scripted non-interactive engine invocation and plugin marker | NOT RUN | Same blocker. |
| (d) provisioned-path PTY round-trip, native prebuild and no pipe fallback | NOT RUN | Same blocker; no provisioned engine path exists. |
| (e) real-home isolation proof | PARTIAL / NOT A PASS | The run was pointed only at fresh `/tmp/task3-20260825/*` directories and did not provision. A complete before/after receipt is therefore not a substitute for the requested successful isolation scenario. |
| (f) negative control: remove sibling package.json and capture silent `0.0.0` | NOT RUN | The binary fails earlier while selecting the wrong embedded manifest, so the intended sibling-package negative control is unreachable. |

No GREEN-after result is claimed. The requested PASS on (a)-(e) and expected-failure capture on (f) cannot be honestly recorded from this binary.

## WHY THIS IS ENOUGH

This is a real compiled executable produced by the approved build command, not a source-level substitute. The failure is deterministic across two isolated first-run invocations and occurs at the embedded-runtime handoff before any user or agent state is touched. The exact runtime stack excerpt identifies the faulty observable and the source predicate that causes it. Fixing the manifest selection to identify the exact top-level runtime manifest, rebuilding, and rerunning this task is required before the six-scenario acceptance criteria can be met.

The issue is outside this task's permitted write scope (only task-3 evidence and `/tmp` scratch may be written), so no implementation file was edited here.

## CLEANUP RECEIPTS

Temporary QA root used:

```text
rm -rf /tmp/task3-20260825 /tmp/task3-stage.ts /tmp/task3-probe.ts /tmp/task3-probe /tmp/task3-probe-build.log /tmp/task3-build.log /tmp/homedir.ts /tmp/homedir
```

The removed QA root contained only fresh isolated HOME/XDG/agent/download directories and captured command output. The build script's temporary staging, plugin-stage, embedded-probe, and any other build scratch directories were removed by the builder's `finally` cleanup paths. The binary remains in the worktree's ignored `dist/release-binaries/` output for reproducibility; it is not a committed evidence file.

Real-home pre-run receipt file:

```text
/tmp/task3-20260825/receipt-before
```

The isolated environment variables were set before both invocations. No quarantine attributes were changed on any user file. The pre-existing unrelated worktree modification was preserved untouched:

```text
.omo/evidence/20260816-remove-omo-telemetry-command/tui-pass/terminal-ansi.txt
```
