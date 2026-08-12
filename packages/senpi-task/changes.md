## 2026-08-06 — Make batch contention coverage scheduler-independent

The batch-admission contention test now injects the typed `contended` lease result directly instead
of depending on 40–120 ms renewal timing. The real renewable-lease behavior remains covered in
`admission-lease.test.ts`; this test is responsible only for proving that a contended acquisition
defers the entire suspended batch without mutating records.

Keep this separation when refactoring admission tests. Reintroducing wall-clock lease expiry into
the batch policy test makes the Windows CI result depend on scheduler pauses rather than behavior.

## 2026-08-12 — Export the shared child progress projection

The package root now exports `createChildProgress` and `ToolProgressDetails` so the OmO Senpi RPC
bridge and the terminal status UI derive live tool, assistant-line, turn, and token progress from one
implementation.

Do not fork the progress grammar or token tracker in downstream adapters; child event interpretation
must remain shared with the task TUI.

## 2026-08-12 — Expose narrow runtime subpaths for packaged adapters

The package now exposes focused subpaths for builtin agents, category resolution, renderer text,
task renderers, and RPC spawn helpers. The OmO Senpi main bundle uses these subpaths so its lazy task
sidecar can own the full task engine without the root barrel pulling every runner into both
artifacts.

Keep the root export for task-component consumers, but use the narrow subpaths from non-task adapter
components. Reintroducing root runtime imports there defeats the split-bundle size guarantee.

## 2026-08-12 — Bound transcript source reads

Task output now reads at most 1 MB of transcript source data, preserving file head and tail content
and propagating source truncation into the returned transcript details. Multi-file child sessions
read only the first and last session files within that shared budget.

Keep the source-read budget ahead of parsing and rendering. A render-only character cap does not
protect the parent process from loading and materializing arbitrarily large child logs.
