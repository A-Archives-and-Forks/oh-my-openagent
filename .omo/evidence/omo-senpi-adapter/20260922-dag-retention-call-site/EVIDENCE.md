# QA evidence — DAG retention call site (#8651)

Host: mengmotaHost (Mac16,11, M4 Pro, 14 cores). Base: `origin/dev` @ `4b5280c1b`.
Branch: `fix/8651-dag-retention-call-site`. Ambient load during measurements: `load averages: 4.08 6.23 9.06` → `4.97 5.91 8.64`.

## WHAT WAS TESTED

1. That `pruneExpired` runs from a **production** seam rather than only from tests — driven through
   `createDagRuntime(...)`, the single production constructor of the DAG store
   (`packages/omo-senpi/src/components/task/index.ts:115` is its only non-test caller).
2. That the sweep does not stall session start (acceptance: "does not run inline on the resume path
   in a way that reintroduces a stall").
3. That the sweep never removes a non-terminal run, an in-window run, or a run whose lease holder is alive.
4. That the sweep's cost is not quadratic in (expired runs × key files).
5. Real-surface behaviour against the actual accumulated state directory.

## WHAT WAS OBSERVED

### Real surface — the accumulated state dir (non-destructive: run against a COPY)

The real directory `~/sisyphuslabs/.omo/senpi-task` was **copied** to `/tmp/dag-retention-probe*`
and the sweep was run there. The real directory was left untouched, re-verified after each run:
`REAL (untouched): 10623 files, 170M`.

| | before fix | after fix |
|---|---|---|
| sweep wall time | **4591.7 ms** | **646.5 ms** (7.1x) |
| runs pruned | 526 | 526 |
| files | 10623 → 1779 | 10623 → 1779 |
| size | 170M → 38M | 170M → 38M |

Outcome is byte-identical; only the cost changed.

Cost decomposition that located the quadratic term (raw fs work, no store):
`checkpoints_parsed: 711  expired_runs: 526  artifact_files: 7792` — `SCAN_ms: 194.0  DELETE_ms: 293.5`.
Raw scan+delete is 487 ms, so the missing ~4.1 s was `pruneRunArtifacts` re-reading the whole `keys`
directory (711 files) once per pruned run: 526 × 711 reads.

### RED → GREEN, with mutation proof

`packages/omo-senpi/src/components/task/dag-retention-sweep.test.ts` — RED (no call site):
`2 pass | 2 fail`.
- FAIL `#then its checkpoint, event log and results are reclaimed` — `Expected: false, Received: true`
- FAIL `#then construction returns before the sweep touches the disk and the sweep still completes` —
  `still present after 2000ms: .../dag/runs/run-deferred.json`
- The two guard cases PASSED vacuously in RED (nothing pruned anything), so each was proven
  fail-able independently:

| mutation | assertion that went RED | neighbours |
|---|---|---|
| retention-window guard removed (`store.ts`) | `#given a terminal run inside retention_days ... #then the run is kept` | stayed green |
| terminal-status guard removed (`store.ts`) | `#given a paused run older than retention_days whose lease holder is alive ... #then the run is kept` | stayed green |
| default scheduler made inline (`dag-retention-sweep.ts`) | `#then construction returns before the sweep touches the disk ...` | stayed green |

Each mutation produced exactly one failure, and it was the assertion naming that behaviour.
Restored after every mutation: `4 pass | 0 fail`.

`packages/senpi-task/src/dag/store-retention-cost.test.ts` pins the complexity by counting directory
scans, not a duration (a timing threshold flakes on a loaded machine; same rationale as
`manager-list-cache.test.ts` in #8649). Mutation — restoring the per-run keys re-scan:
`Expected: 1, Received: 6` (1 index scan + 5 per-run scans). Restored: `2 pass | 0 fail`.

### Gates

- `bun test packages/senpi-task/src/dag/` → **318 pass / 0 fail**, 1276 expect() calls, 21 files.
- `bun test packages/omo-senpi/src/components/task/` → **627 pass / 0 fail**, 1769 expect() calls, 78 files.
- `bunx tsgo --noEmit -p packages/omo-senpi/tsconfig.json` → exit 0.
- `bun run test:senpi` → see `test-senpi-gate.txt` in this directory.

## WHY IT IS ENOUGH

The defect was "the function has no production call site", so the test that matters is the one that
reaches it the way production does. All four cases construct `createDagRuntime` and assert on
**durable state** (files present/absent on disk), never on the call having been made — deleting the
call site turns the suite red. The quadratic fix is pinned by a read-count assertion that is proven
fail-able, and the real-surface run shows the same 526 runs reclaimed before and after, so the
optimisation changed cost and not behaviour.

## WHAT WAS OMITTED / RESIDUAL RISK

- The sweep was **not** run destructively against the user's live `~/sisyphuslabs/.omo/senpi-task`.
  Every measurement used a copy; the real directory is unchanged and still holds its 10623 files.
  The first real session on this machine after the fix ships will reclaim them.
- 646 ms is still synchronous work on the main thread once the deferred macrotask fires. It is off
  the session-start path and is a one-time catch-up for a 25-day backlog (steady state sweeps a far
  smaller set), but a directory orders of magnitude larger would want chunking. Not needed at the
  measured scale; called out rather than hidden.
- Live-harness driving (`senpi-qa` real-binary drivers) is not the discriminating surface for this
  change: the behaviour under test is filesystem retention, which the real-state-dir run above
  exercises directly with the production store.
