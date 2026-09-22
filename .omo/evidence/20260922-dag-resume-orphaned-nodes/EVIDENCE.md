# QA evidence - DAG resume liveness gate (#8657)

Change: `packages/senpi-task/src/dag/recovery.ts` refuses to re-adopt a `pending`/`running` task
record that this host does not hold, failing the node as `resume_task_orphaned` instead of pinning
it at `running` forever.

## What was tested

| Surface | Command | Why it proves something |
|---|---|---|
| Recovery seam (new) | `bun test src/dag/recovery-orphaned.test.ts` | Drives `createDagRecovery().resumePausedRuns()` over a real `createDagFileStore` checkpoint; asserts the **durable checkpoint on disk**, not the driver's return value |
| DAG engine | `bun test src/dag/` | Whole subsystem, including the two suites whose fake managers were repaired |
| Engine packages | `bun test src/dag src/lifecycle src/manager` (packages/senpi-task) | The lifecycle/manager neighbours of the seam |
| Adapter | `bun test --timeout 20000 packages/omo-senpi/src/components/task` | The DAG runtime composition that injects `reattach` |
| Types | `tsgo --noEmit -p packages/omo-senpi/tsconfig.json`, `-p packages/senpi-task/tsconfig.json` | New error code + gate typecheck |
| Committed bundle | `node packages/omo-senpi/plugin/scripts/build-extension.mjs --check`, `build-install.mjs --check` | CI's bundle-freshness gate (the engine change is bundled into `extensions/omo-task.js`) |

## What was observed

**RED at `ec999486d` (before the gate), as an assertion rather than a suite timeout:**

```
247 |     expect(race).toBe("resumed")
                       ^
error: expect(received).toBe(expected)
Expected: "resumed"
Received: "awaited-orphan:task-parked"
      at packages/senpi-task/src/dag/recovery-orphaned.test.ts:247:18
```

The resume is raced against the fake manager's first `waitFor` call. A settlement wait on a child
this host does not hold never resolves, so the race resolving as `awaited-orphan` IS the production
hang - the node would stay `running` in the checkpoint forever. Before this race guard the same
test failed as a 30s timeout; the guard turns the hang into a named assertion.

**Mutation proof.** Reverting only the five-line gate (snapshot restore, not `git checkout`) reddens
exactly that assertion and nothing else: `2 pass / 1 fail`. Restoring the file byte-identically
(`diff -q` clean) returns `3 pass / 0 fail`. The two control tests stay green in BOTH states, which
is what proves the gate does not over-fail:

- a running node whose child this host **does** hold is still reattached and folds when it settles;
- a node started fresh by recovery whose admission is queued (`pending`, no handle yet) is not
  judged orphaned.

**Gates (all at base `ec999486d`):**

```
packages/senpi-task  bun test src/dag                      323 pass / 0 fail   (was 321/2 before the fixture repair)
packages/senpi-task  bun test src/dag src/lifecycle src/manager
                                                           850 pass / 0 fail across 93 files
repo root            bun test packages/omo-senpi/src/components/task
                                                           627 pass / 0 fail across 78 files
repo root            tsgo --noEmit -p packages/omo-senpi/tsconfig.json     clean
repo root            tsgo --noEmit -p packages/senpi-task/tsconfig.json    clean (exit 0)
repo root            build-extension.mjs --check / build-install.mjs --check   current
```

**Fixture repair, not test weakening.** `recovery.test.ts` and `recovery-nonblocking.test.ts` each
carried a fake `TaskManager` that hardcoded `getResidentHandle(): undefined` while simulating a child
it would later settle through `waitFor`. The real manager cannot produce that world: `waitFor`
resolves from an already-terminal stored record or from the in-process waiter map, and that map is
fed only by children in `#live` - the same map `getResidentHandle` reads (`manager.ts:653,749-782`).
Both fakes now answer "held" from the map their completions come from. No assertion was relaxed and
no test was skipped; the two suites went red for one reason (an unfaithful mock) and are green again
with their original expectations intact.

**Live specimen, before the fix** (a 7-node run that had been resumed six times; the project's own
state dir, read-only):

```
status                paused
generation            6
checkpointSeq         51
previousLeaseHolderPid <pid of the process that resumed it last>
L1-thread-open        state=running   taskId=st_01a0c78a   error=(none)
L7-quota-surfacing    state=running   taskId=st_01a0c78e   error=(none)
```

Both children's backing sessions no longer exist anywhere: one record is parked at
`residency_state=rpc_detached, suspension_reason=daemon_unavailable`, the other is frozen `resident`
under a foreign pid. A controlled resume of that session (kill, `--session`, diff the durable files
45s later) moved the checkpoint `paused -> running`, incremented the generation, took a new lease,
and re-stamped the parked child's `updated_at` to resume time while its pid stayed null - a sixth
re-adoption of two dead nodes. The acceptance for this change is that the same sequence on a runtime
carrying the gate leaves both nodes `failed` with `error.code: resume_task_orphaned` and does not
re-stamp the child record as running. Recorded post-merge in `LIVE-AFTER.md` beside this file.

## Why this is enough

The seam under test is the exact production entry point (`resumePausedRuns`), driven over a real
file store, and every assertion reads the durable checkpoint - the artifact that outlives the
process and that the widget renders from. The failure mode is a hang, so the RED is shaped as a race
against the hang's cause rather than a timeout, making it falsifiable in milliseconds. The gate is
mutation-proven in isolation, and the two controls cover the ways an over-eager gate would break
legitimate resumes.

## What was omitted

No hostnames, machine names, absolute home paths, daemon socket paths or instance identifiers are
reproduced here; the pid observed in the controlled resume is elided. The specimen's raw checkpoint
and task records stay in the local project state dir and are not copied into the repo.
