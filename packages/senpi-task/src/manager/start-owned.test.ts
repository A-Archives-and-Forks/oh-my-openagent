import { afterEach, describe, expect, test } from "bun:test"

import type { DagTaskOwner } from "../dag/owner"
import type { DagNodeId, DagRunId } from "../dag/types"
import { createTaskRecordStore } from "../store"
import type { TaskRecordStore } from "../store"
import { FakeRunner, baseSpec, categoryPlanner, cleanupProjects, makeManager, settings, tempProject } from "./__fixtures__/manager-fakes"
import { createTaskManager } from "./manager"
import type { SpawnAdmission } from "./types"

const owner: DagTaskOwner = {
  kind: "dag",
  runId: "run-1" as DagRunId,
  nodeId: "node-1" as DagNodeId,
  fingerprint: "fingerprint-1",
}

afterEach(cleanupProjects)

describe("TaskManager.startOwned", () => {
  test("#given a new DAG owner #when started #then the initial claim persists the owner before launch", async () => {
    // given
    const project = tempProject()
    const inner = createTaskRecordStore({ project_dir: project })
    let claimedOwner: unknown
    const store: TaskRecordStore = {
      ...inner,
      save(record) {
        claimedOwner = record.owner
        inner.save(record)
      },
    }
    const runner = new FakeRunner()
    const manager = createTaskManager({
      store,
      runners: { "in-process": runner, process: runner },
      planner: categoryPlanner(),
      config: settings({ default_concurrency: 5, max_depth: 1 }),
      cwd: project,
    })

    // when
    const result = await manager.startOwned(baseSpec(), owner)

    // then
    expect(result.kind).toBe("started")
    if (result.kind !== "started") throw new Error("expected started")
    expect(result.reused).toBe(false)
    expect(claimedOwner).toEqual(owner)
    expect(inner.load(result.task_id)?.owner).toEqual(owner)
    expect(runner.startedSpecs).toHaveLength(1)
  })

  test("#given an existing owner with the same fingerprint #when started again #then it reuses one persisted task and never double-spawns", async () => {
    // given
    const { manager, store, inProcess } = makeManager()
    const first = await manager.startOwned(baseSpec(), owner)
    if (first.kind !== "started") throw new Error("expected first start")

    // when
    const second = await manager.startOwned(baseSpec(), owner)

    // then
    expect(second.kind).toBe("started")
    if (second.kind !== "started") throw new Error("expected reused start")
    expect(second.reused).toBe(true)
    expect(second.task_id).toBe(first.task_id)
    expect(store.list().records).toHaveLength(1)
    expect(inProcess.startedSpecs).toHaveLength(1)
    expect(manager.findOwnedTask(owner)?.task_id).toBe(first.task_id)
  })

  test("#given an existing owner with a different fingerprint #when started again #then it returns owner_conflict without another task", async () => {
    // given
    const { manager, store, inProcess } = makeManager()
    const first = await manager.startOwned(baseSpec(), owner)
    if (first.kind !== "started") throw new Error("expected first start")

    // when
    const conflict = await manager.startOwned(baseSpec(), { ...owner, fingerprint: "fingerprint-2" })

    // then
    expect(conflict).toEqual({
      kind: "owner_conflict",
      task_id: first.task_id,
      existing_fingerprint: "fingerprint-1",
      requested_fingerprint: "fingerprint-2",
    })
    expect(store.list().records).toHaveLength(1)
    expect(inProcess.startedSpecs).toHaveLength(1)
  })

  test("#given caller journal knowledge is lost after dispatch #when a fresh manager starts the same owner #then recovery finds exactly one task", async () => {
    // given
    const project = tempProject()
    const firstManager = makeManager({ project })
    const first = await firstManager.manager.startOwned(baseSpec(), owner)
    if (first.kind !== "started") throw new Error("expected first start")

    // when
    const recoveredManager = makeManager({ project })
    const recovered = await recoveredManager.manager.startOwned(baseSpec(), owner)

    // then
    expect(recovered.kind).toBe("started")
    if (recovered.kind !== "started") throw new Error("expected recovered start")
    expect(recovered.reused).toBe(true)
    expect(recovered.task_id).toBe(first.task_id)
    expect(recoveredManager.store.list().records).toHaveLength(1)
    expect(recoveredManager.inProcess.startedSpecs).toHaveLength(0)
  })

  test("#given depth, residency, and concurrency gates #when owned starts are attempted #then the existing manager outcomes remain authoritative", async () => {
    // given
    const depth = makeManager({ config: settings({ default_concurrency: 1, max_depth: 1 }) })
    const deniedAdmission = (): Promise<SpawnAdmission> => Promise.resolve({ kind: "rejected", message: "cap reached" })
    const residency = makeManager({ admit: deniedAdmission })
    const queued = makeManager({ config: settings({ default_concurrency: 1, max_depth: 1 }) })

    // when
    const depthResult = await depth.manager.startOwned(baseSpec({ depth: 2 }), owner)
    const residencyResult = await residency.manager.startOwned(baseSpec(), owner)
    const running = await queued.manager.startOwned(baseSpec({ name: "running" }), owner)
    const pending = await queued.manager.startOwned(
      baseSpec({ name: "pending" }),
      { ...owner, nodeId: "node-2" as DagNodeId, fingerprint: "fingerprint-2" },
    )

    // then
    expect(depthResult.kind).toBe("depth_denied")
    expect(depth.store.list().records).toHaveLength(0)
    expect(residencyResult.kind).toBe("residency_denied")
    expect(residency.store.list().records).toHaveLength(0)
    expect(running.kind).toBe("started")
    expect(pending.kind).toBe("started")
    if (pending.kind !== "started") throw new Error("expected pending start")
    expect(pending.reused).toBe(false)
    if (pending.reused) throw new Error("expected fresh pending start")
    expect(pending.status).toBe("pending")
    expect(pending.queue_position).toBe(1)
    expect(queued.store.list().records).toHaveLength(2)
  })
})
