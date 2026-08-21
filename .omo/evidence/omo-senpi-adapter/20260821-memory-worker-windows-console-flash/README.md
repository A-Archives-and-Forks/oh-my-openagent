# Memory reflection worker: empty console window flash on Windows

Change under test: add `windowsHide: true` to every `spawn`/`spawnSync` in the memory reflection
worker launch chain (`spawn-supervisor.ts`, `memory-run-supervisor.ts`,
`supervisor-process-identity.ts`).

## Reported symptom

On Windows, an empty terminal window occasionally flashes open and closes again while omo is
running normally. It is intermittent, not once per turn.

## Mechanism (proven, not assumed)

The reflection supervisor is launched with `detached: true`, which on Windows means
`DETACHED_PROCESS`: the supervisor and everything below it run with **no console at all**. A
console-subsystem program started from a console-less parent gets a **brand new console**, and that
console owns a **visible window** unless the process is created with `CREATE_NO_WINDOW`
(Node's `windowsHide: true`).

The production path that hits this is the win32 tree kill: `terminateSupervisorChildHard` ->
`spawnTerminationCommand` -> `taskkill /pid <pid> /T /F`. That runs only on deadline, hard-kill, and
cleanup paths, which is why the window appears only sometimes.

## What was tested

### 1. Mechanism isolation - `probe-console-allocation.mjs` -> `probe-console-allocation.json`

- **What was tested:** a console-subsystem child (`cmd.exe`) spawned from a detached, console-less
  parent, once without `windowsHide` and once with it. Win32 `AttachConsole` + `GetConsoleWindow` +
  `IsWindowVisible` report whether that child owns a visible console window.
- **Observed result:** without the flag `windowHandle = 4789456`, `windowVisible = true` (a real
  empty console window on the desktop). With the flag `windowHandle = 0`, `windowVisible = false`.
- **Why sufficient:** it pins the exact mechanism behind the symptom, independent of omo code.

### 2. Production path A/B - `qa-taskkill-console.mjs` -> `taskkill-baseline.json`, `taskkill-after.json`

- **What was tested:** the REAL production function `terminateSupervisorChildHard` called from
  inside a detached, console-less process, i.e. the exact shape the supervisor runs as. Only the
  killed command is swapped, through the module's own documented test seam
  (`OMO_MEMORY_SUPERVISOR_TASKKILL_COMMAND`), for a long-lived stand-in so the spawned process can
  be probed while alive. The spawn call and its options are untouched production code.
- **Observed result:**
  - baseline (fix reverted via `git stash`): `windowHandle = 34671160`, `windowVisible = true`,
    `visibleConsoleWindows = 1`.
  - after (fix applied): `windowHandle = 0`, `windowVisible = false`, `visibleConsoleWindows = 0`.
- **Why sufficient:** the user-visible defect (a visible console window) is produced and then
  removed by this change alone, through production code.

### 3. Supervisor chain smoke - `qa-windows-console.mjs` -> `after.json`

- **What was tested:** the real supervisor chain (`memory-run-supervisor.ts` -> child bootstrap ->
  model child) launched end to end with a harmless sleeping stand-in for the model command, probing
  every process in the resulting tree.
- **Observed result:** supervisor, bootstrap, and model child all report `windowHandle = 0`,
  `windowVisible = false`; `processesWithConsoleWindow = 0`.
- **Why sufficient:** it confirms the fixed chain starts and runs with no console window anywhere.
  Note this run does NOT reproduce the defect on the baseline, because the stand-in model command
  never touches a console and therefore never allocates one. The defect reproduction lives in
  evidence 2, which is why that A/B is the load-bearing proof.

### 4. Regression test - `windows-console-hide.test.ts`

- **What was tested:** `bun test packages/omo-senpi/src/components/memory/worker/windows-console-hide.test.ts`,
  a source audit asserting every `spawn`/`spawnSync` in the three chain files passes
  `windowsHide: true`, plus a count assertion so the audit cannot silently stop covering calls.
- **Observed result:** failing-first with the fix reverted (5 offenders: `spawn-supervisor.ts:208`,
  `memory-run-supervisor.ts:47`, `memory-run-supervisor.ts:98`,
  `supervisor-process-identity.ts:115`, `supervisor-process-identity.ts:119`), green with the fix
  (2 pass, 0 fail).
- **Why sufficient:** the flag is invisible at runtime on non-Windows CI, so a source-level audit is
  the only gate that keeps a future spawn in this chain from reintroducing the window.

## Isolation

Every probe runs in a `mktemp` directory under the OS temp dir and spawns only stand-in processes
(`cmd.exe ping`, `node setTimeout`). No senpi binary, no `~/.senpi/agent`, no `~/.omo` state, and no
real reflection run was involved, so no user state could be read or written. All spawned trees are
torn down with `taskkill /T /F` at the end of each script.

## Omitted

The probe scripts inherit `process.env` when launching their stand-in children (the production
supervisor does the same). Captured JSON records only pids, window handles, and process names, so
no environment values, tokens, or credentials are written to disk here.

## Residual risk

`packages/omo-senpi/src/components/memory/commands/people-ask.ts`,
`worker/model-preflight.ts`, and the `init-deep-advisor` git calls also spawn without
`windowsHide`, but they run in the main senpi process, which owns a console, so they inherit it and
show no window. They are left unchanged and out of scope for this fix.
