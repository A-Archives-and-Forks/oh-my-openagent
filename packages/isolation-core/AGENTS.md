# isolation-core

Harness-neutral filesystem isolation PAL; real backend implementations are supplied
by callers. This package does not implement merge-back or task-runner integration.

Provenance: ported from oh-my-pi `crates/pi-iso` + `task/isolation-*`, MIT.
Candidate ordering, unavailable-only fallback and retention follow that upstream.
The owner protocol adds process-instance identity, daemon session ownership and
atomic publication. No Rust/napi crate or `.node` sidecar is required.
ProjFS is excluded: its driver-callback provider API requires a native callback
host, not a Bun-callable clone operation.

## Contract

- Backends write only inside the supplied context base directory. `start` targets
  its `m` child; `stop` must be safe after a partially failed start.
- `IsolationUnavailableError` permits fallback. Other errors propagate. A failed
  teardown preserves the tree rather than recursively removing an active mount.
- `chooseBaseDir(repoRoot, homeDir, id)` selects a same-device location, using a
  mkdir/remove probe for a volume root. Its optional I/O seam is for deterministic
  device tests. A home fallback on another device excludes tree-cloning backends.
- `ensureIsolation` claims a unique `.creating-<pid>` sibling before starting,
  then publishes with rename. Existing published or in-flight directories are not
  overwritten; use stale sweeping to reclaim dead attempts.
- Ownership is checked before age. Foreign, retained, live and unknown owners
  are never automatically deleted. Creating/malformed markers get a ten-minute
  grace period. A live creating owner survives regardless of age.
- Process identity reuses memory-core's lazily loaded native functions without
  its subprocess fallback. Node returns null and uses PID-only liveness.
- `sweepStaleIsolations(roots, { backends, probe })` stops the recorded backend
  before removal. Without a matching backend implementation it reports a skip;
  without a daemon probe it keeps host-session children as unknown.
- `retainIsolation(handle, reason)` transfers the tree to a retained path and
  invalidates the old handle paths. Manual removal requires stopping its recorded
  backend at `<retainedPath>/m` before recursively removing the retained directory.

## Verification

Run focused files with `bun test packages/isolation-core/src/<name>.test.ts`.
The package suite is `bun test packages/isolation-core`; typecheck uses
`tsgo --noEmit -p packages/isolation-core/tsconfig.json`.
Tests use fake backends against actual directories, plus injected device/liveness
probes. No real backend or mount is required for this scaffold.
