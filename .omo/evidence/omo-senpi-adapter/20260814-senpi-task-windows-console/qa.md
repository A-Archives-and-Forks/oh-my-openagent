# Windows RPC child console QA

## Scope

This evidence covers:

- the production Senpi `execution_mode: "process"` route;
- the default RPC child spawn options;
- Windows console allocation with `windowsHide: false`;
- Windows console suppression with production `windowsHide: true`;
- RPC stdio round-trip;
- real credential isolation;
- child/process-tree teardown;
- generated `omo-task.js` delivery.

## Reproducible surfaces

Package-owned console probe:

`packages/senpi-task/src/runners/rpc/__fixtures__/windows-console-probe.ts`

Package-owned console host:

`packages/senpi-task/src/runners/rpc/__fixtures__/windows-console-host.ps1`

Production routing driver:

`packages/omo-senpi/scripts/qa/task-rpc-e2e.mjs`

Exact commands are recorded in:

- `probe-command.txt`
- `routing-command.txt`

## RED progression

| Workflow/job | Observed failure | Root fix |
|---|---|---|
| `31925417976` / `95112165297` | prose-only evidence and no current-head Windows test | checked-in probe and Windows test |
| `31927904705` / `95118244973` | both controls reported `MainWindowHandle: 0`; GUI handle is not a hosted-runner console oracle | use Win32 console attachment |
| `31930067950` / `95118244973` | direct detached topology had no console to attach | add an explicit console host |
| `31931659970` / `95123440107` | redirected PowerShell host deadlocked after allocating a console | event-driven ready/stop files with no redirected host stdio |
| `31932110216` / `95128456220` | `AllocConsole` returned Win32 error 5 because the host already owned a console | accept error 5 as the satisfied precondition |
| `31932110216` / `95128456257` | production route was GREEN, but the child crashed because the QA sandbox mixed `RUNNER~1` with a canonical path | canonicalize the sandbox root using `realpathSync.native` |

Raw failure payloads:

- `windows-console-probe-red.json`
- `windows-routing-red.json`

## Local GREEN

- `bun test packages/senpi-task/src/runners`
  - 118 pass, 1 Windows-only skip, 0 fail.
- `bun run --cwd packages/senpi-task typecheck`
  - exit 0.
- `bun run --cwd packages/omo-senpi typecheck`
  - exit 0.
- `bun test`
  - 15,125 pass, 7 intentional platform/TUI skips, 0 fail.
- `bun run typecheck`
  - exit 0 across root, scripts, and packages.
- `bun run test:senpi`
  - 1,568 pass, 1 Windows-only skip, 0 fail.
- `bun run test:codex`
  - 519 pass, 0 fail.
- Bun 1.3.12 `build-extension.mjs --check`
  - all runtimes and extension bundles current.
- Isolated Codex installer QA
  - plugin, config, bins, and agent TOMLs landed in a throwaway `CODEX_HOME`;
  - real `~/.codex/config.toml` unchanged.

The local production driver reached the RPC runner with:

- `wiringFixed: true`
- real process-mode PID and child session JSONL
- steer acknowledgement
- completion delivery
- killed-child classification
- real credentials and full real agent-directory digest unchanged
- `leakedPids: 0`

Its separate reconcile scenario still records an unrelated breadcrumb mismatch while confirming the orphan is dead; the routing-specific checks remain truthful and GREEN.

## Required Windows GREEN payloads

The final Windows workflow must emit:

`WINDOWS_CONSOLE_PROBE`

- visible control: `consoleAttached: true`
- hidden production child: `consoleAttached: false`
- hidden production child: `mainWindowHandle: 0`
- both stdio round trips: `true`
- both children exited: `true`
- credentials untouched: `true`
- temporary root removed: `true`

`WINDOWS_TASK_RPC_E2E`

- `wiringFixed: true`
- `process_mode_routes_to_rpc_runner: PASS`
- real RPC child PID
- child session JSONL: `true`
- credentials and full agent directory unchanged
- no leaked RPC PIDs

The final GREEN workflow/job URLs and captured payloads will be added to this directory after the current evidence commit triggers the authoritative head run.

## Isolation and cleanup

- The console probe uses a fresh `mkdtemp` root and redirects both parent and child Senpi agent/session directories into it.
- The production driver ignores a caller-provided agent directory and creates its own canonical sandbox.
- Credential files are compared by digest only; digest values and credential contents are never printed.
- On timeout, the Windows tests use `taskkill /T /F` and await confirmed process close.
- Probe/driver outputs assert zero live child PIDs before success.
- Headless Parallels recovery never reached VM readiness; the Windows VM was not started and no guest checkout was created.

## Omitted

No provider tokens, auth headers, credential bodies, raw environment dumps, or private configuration contents are retained.
