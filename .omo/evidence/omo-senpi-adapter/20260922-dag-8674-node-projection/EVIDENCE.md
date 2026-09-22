# QA evidence - #8674 DAG node output + activity projection

## WHAT WAS TESTED

The surface the issue is about: what a parent agent sees from `workflow action=snapshot` while a run
is live. The driver `packages/omo-senpi/scripts/qa/dag-node-projection-qa.ts` composes the REAL
`DagFileStore`, `TaskRecordStore`, `DagManager`, `DagScheduler`, `TaskManager` and `runDagTool` over
a temp project dir, and reproduces the reporter's exact shape: a two-node run where one node settles
with a claim and the other stays `running` with its child's last transcript write backdated to 51
minutes ago (`fs.utimesSync`, so the clock is exact rather than timing-dependent).

No `senpi` spawn. Same precedent as the sibling DAG drivers `dag-gate-proof.ts` and
`dag-wait-detach-qa.ts`, which state that for the DAG tool the engine + adapter composition IS the
real surface; nothing in this change touches the binary, the extension host, or a provider.

Command:

```sh
bun packages/omo-senpi/scripts/qa/dag-node-projection-qa.ts --out-dir <this dir>
```

## WHAT WAS OBSERVED

Exit 0, no violations. Captured verbatim in `dag-node-projection-qa.json`.

Model-visible first line, which before this change said only `... is running (1/2 nodes complete).`:

```
Dag run run-node-projection is running (1/2 nodes complete). Quiet children, no transcript activity: clone-profile (51m).
```

Settled node (`clone-sources`), previously projected with no output at all:

```
"state": "completed",
"completedAt": "2026-09-22T16:39:20.993Z",
"output": "cloned 42 source rows into sources.html; 21/21 class hooks used",
"outputBytes": 63
```

Running node (`clone-profile`), previously indistinguishable from a working child:

```
"state": "running",
"startedAt": "2026-09-22T16:39:20.989Z",
"lastActivityAt": "2026-09-22T15:48:20.996Z"
```

Unit gates on the same tree:

- `bun test packages/senpi-task/src/dag` -> 330 pass / 0 fail
- `bun test packages/omo-senpi/src/components/task/dag-quiet-nodes.test.ts` -> 4 pass / 0 fail
- `tsgo --noEmit -p packages/senpi-task/tsconfig.json` -> rc 0
- `tsgo --noEmit -p packages/omo-senpi/tsconfig.json` -> rc 0
- `node packages/omo-senpi/plugin/scripts/build-extension.mjs --check` -> `build is current` after regeneration

Mutation proof (each fix reverted alone, the other left in place):

- revert only the `output`/`outputBytes` stamping in `applyDagSchedulerEvent` -> all 4 output
  assertions RED, all 3 activity assertions GREEN
- revert only `withNodeActivity` in `projectSnapshot` -> 2 of 3 activity assertions RED, all 4
  output assertions GREEN. The third activity test asserts ABSENCE on a settled node and therefore
  stays green under that mutation by construction; it is an over-projection guard, not feature proof.

## WHY IT IS ENOUGH

The issue is a projection contract, and every assertion is made against durable state or against the
exact bytes the model receives: the on-disk checkpoint JSON (`node.output`, `node.outputBytes`,
`node.completedAt`), the snapshot the tool returns, and the tool's own first line. The one piece of
behaviour that cannot be asserted from a unit test - that the notice reaches the text the model reads
first - is what this driver captures.

Residual risk: `lastActivityAt` is one `statSync` per live node per snapshot, on the status-UI and
RPC-bridge heartbeat paths. It is bounded by the resident-child cap rather than by run size, and
terminal nodes are skipped, so a 64-node run with 16 residents stats at most 16 files per tick.

## WHAT WAS OMITTED

The stuck-node half of #8674 - a node that never LEAVES `running` because its child's task record
never goes terminal - is not covered here and is not fixed by this change; it is #8659's lifecycle
question. This driver deliberately proves only that such a node is now VISIBLE as quiet.

Nothing secret-bearing was captured: the driver runs entirely inside a temp project dir it creates
and deletes, with a scripted runner and no provider, no auth, and no user paths beyond the temp root.
