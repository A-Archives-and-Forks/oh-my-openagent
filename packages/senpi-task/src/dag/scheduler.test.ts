// allow: SIZE_OK - the scheduler acceptance matrix keeps wave ordering, failure continuation, queue reporting, and residency batching in one fake-manager fixture.
import { afterEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { ManagerStartSpec, TaskManager } from "../manager/types"
import type { TaskRecord, TaskStatus } from "../state"
import { compileDag, type DagDefinition } from "./graph"
import type { DagRunRecordV1 } from "./manager"
import type { DagTaskOwner, OwnedStartResult } from "./owner"
import { createDagScheduler } from "./scheduler"
import { createDagFileStore } from "./store"
import type { DagNodeId, DagRunEvent, DagRunId } from "./types"

const cleanupRoots: string[] = []
const runId = "run-scheduler" as DagRunId
const parentSessionId = "ses-parent"
const rootSessionId = "ses-root"

function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
} {
  let resolve = (_value: T): void => undefined
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

afterEach(() => {
  for (const root of cleanupRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function tempProject(): string {
  const directory = fs.mkdtempSync(join(tmpdir(), "senpi-dag-scheduler-"))
  cleanupRoots.push(directory)
  return directory
}

function node(id: string, dependsOn: readonly string[] = []) {
  return { id, prompt: `do ${id}`, category: "quick", ...(dependsOn.length === 0 ? {} : { dependsOn }) } as const
}

function definition(nodes: DagDefinition["nodes"]): DagDefinition {
  return { key: "scheduler-test", name: "scheduler test", nodes }
}

function recordFor(input: DagDefinition): DagRunRecordV1 {
  const createdAt = "2026-08-14T00:00:00.000Z"
  const compiled = compileDag(input, { at: createdAt })
  if (!compiled.ok) throw new Error("test DAG did not compile")
  return {
    schemaVersion: 1,
    checkpointSeq: 0,
    runId,
    runKey: input.key,
    name: input.name,
    parentSessionId,
    rootSessionId,
    definitionFingerprint: "definition-fingerprint",
    definition: {
      key: input.key,
      name: input.name,
      nodes: input.nodes.map((entry) => ({ ...entry, effectivePrompt: entry.prompt })),
    },
    status: "pending",
    generation: 1,
    createdAt,
    updatedAt: createdAt,
    nodes: compiled.nodes,
    edges: compiled.edges,
    waves: compiled.waves,
    criticalPath: compiled.criticalPath,
    bottlenecks: compiled.bottlenecks,
    diagnostics: compiled.diagnostics,
  }
}

type StartFailureKind = "plan_unresolved" | "depth_denied" | "start_failed"

type FakeOptions = {
  readonly residencyLimit?: number
  readonly autoComplete?: boolean
  readonly startFailureNodeIds?: readonly string[]
  readonly startFailureKinds?: Readonly<Record<string, StartFailureKind>>
  readonly queuedNodeIds?: readonly string[]
}

type MutableTask = {
  record: TaskRecord
  readonly completion: ReturnType<typeof deferred<TaskRecord>>
}

class FakeTaskManager implements TaskManager {
  readonly starts: string[] = []
  readonly attempts: string[] = []
  readonly residencyDenials: string[] = []
  maxResidents = 0

  readonly #options: FakeOptions
  readonly #tasks = new Map<string, MutableTask>()
  readonly #startedSignals = new Map<string, ReturnType<typeof deferred<void>>>()
  #residents = 0
  #taskCounter = 0

  constructor(options: FakeOptions = {}) {
    this.#options = options
  }

  whenStarted(nodeId: string): Promise<void> {
    let signal = this.#startedSignals.get(nodeId)
    if (signal === undefined) {
      signal = deferred<void>()
      this.#startedSignals.set(nodeId, signal)
    }
    if (this.starts.includes(nodeId)) signal.resolve()
    return signal.promise
  }

  complete(nodeId: string, status: TaskStatus = "completed"): void {
    const task = [...this.#tasks.values()].find((entry) => entry.record.owner?.nodeId === nodeId)
    if (task === undefined) throw new Error(`unknown fake task for ${nodeId}`)
    if (task.record.status === "pending" || task.record.status === "running") this.#residents -= 1
    task.record = {
      ...task.record,
      status,
      updated_at: "2026-08-14T00:00:01.000Z",
      ...(status === "completed" ? { final_response: `done ${nodeId}` } : { error_message: `${status} ${nodeId}` }),
    }
    task.completion.resolve(task.record)
  }

  async startOwned(_spec: ManagerStartSpec, owner: DagTaskOwner): Promise<OwnedStartResult> {
    const nodeId = owner.nodeId as string
    this.attempts.push(nodeId)
    const existing = [...this.#tasks.values()].find((entry) => entry.record.owner?.nodeId === owner.nodeId)
    if (existing !== undefined) {
      return {
        kind: "started",
        reused: true,
        task_id: existing.record.task_id,
        status: existing.record.status,
        name: existing.record.name ?? existing.record.task_id,
      }
    }
    const startFailureKind = this.#options.startFailureKinds?.[nodeId] ??
      (this.#options.startFailureNodeIds?.includes(nodeId) === true ? "start_failed" : undefined)
    if (startFailureKind === "plan_unresolved") {
      return { kind: "plan_unresolved", error: { code: "unknown_target", message: `unresolved ${nodeId}` } }
    }
    if (startFailureKind === "depth_denied") {
      return { kind: "depth_denied", reason: `depth denied ${nodeId}`, child_depth: 2, max_depth: 1 }
    }
    if (startFailureKind === "start_failed") {
      return {
        kind: "start_failed",
        task_id: `failed-${nodeId}`,
        name: nodeId,
        category: "quick",
        execution_mode: "in-process",
        model: "fake-model",
        run_in_background: true,
        error_message: `failed to start ${nodeId}`,
      }
    }
    const limit = this.#options.residencyLimit ?? Number.POSITIVE_INFINITY
    if (this.#residents >= limit) {
      this.residencyDenials.push(nodeId)
      return { kind: "residency_denied", reason: "resident child cap reached" }
    }

    this.#taskCounter += 1
    this.#residents += 1
    this.maxResidents = Math.max(this.maxResidents, this.#residents)
    const taskId = `task-${this.#taskCounter}`
    const queued = this.#options.queuedNodeIds?.includes(nodeId) === true
    const completion = deferred<TaskRecord>()
    const task: MutableTask = {
      completion,
      record: {
        task_id: taskId,
        name: nodeId,
        parent_session_id: parentSessionId,
        root_session_id: rootSessionId,
        depth: 1,
        category: "quick",
        execution_mode: "in-process",
        model: "fake-model",
        notify_on_terminal: true,
        owner,
        status: queued ? "pending" : "running",
        residency_state: "resident",
        created_at: "2026-08-14T00:00:00.000Z",
        updated_at: "2026-08-14T00:00:00.000Z",
        notification: { run_epoch: 1, notified_epoch: 0 },
      },
    }
    this.#tasks.set(taskId, task)
    this.starts.push(nodeId)
    this.#startedSignals.get(nodeId)?.resolve()
    if (this.#options.autoComplete !== false) queueMicrotask(() => this.complete(nodeId))
    return {
      kind: "started",
      reused: false,
      task_id: taskId,
      status: queued ? "pending" : "running",
      name: nodeId,
      ...(queued ? { queue_position: 3 } : {}),
    }
  }

  waitFor(taskId: string): Promise<TaskRecord> {
    const task = this.#tasks.get(taskId)
    if (task === undefined) throw new Error(`unknown fake task ${taskId}`)
    return task.completion.promise
  }

  findOwnedTask(owner: Pick<DagTaskOwner, "kind" | "runId" | "nodeId">): TaskRecord | undefined {
    return [...this.#tasks.values()].find((entry) =>
      entry.record.owner?.kind === owner.kind &&
      entry.record.owner.runId === owner.runId &&
      entry.record.owner.nodeId === owner.nodeId,
    )?.record
  }

  get(taskId: string): TaskRecord | undefined {
    return this.#tasks.get(taskId)?.record
  }

  start(): Promise<never> { throw new Error("not implemented") }
  continueTask(): Promise<never> { throw new Error("not implemented") }
  sendToTask(): Promise<never> { throw new Error("not implemented") }
  interruptTask(): Promise<never> { throw new Error("not implemented") }
  cancelTask(): Promise<never> { throw new Error("not implemented") }
  list(): readonly [] { return [] }
  forget(): void {}
  getResidentHandle(): undefined { return undefined }
  subscribeChild(): () => void { return () => undefined }
  residentTaskIds(): readonly string[] { return [] }
  promoteToBackground(): boolean { return false }
  wasBackground(): boolean { return true }
}

function schedulerFixture(input: DagDefinition, taskManager: FakeTaskManager) {
  const store = createDagFileStore({ project_dir: tempProject() })
  const initialRecord = recordFor(input)
  store.writeCheckpoint(runId, initialRecord)
  const scheduler = createDagScheduler({ store, taskManager, initialRecord, now: () => Date.parse("2026-08-14T00:00:02.000Z") })
  const events = (): readonly DagRunEvent[] => store.readEvents(runId, 0, { limit: 100 }).events
  return { scheduler, events }
}

function waveMembership(events: readonly DagRunEvent[], type: "dag.wave.started" | "dag.wave.completed"): readonly string[][] {
  return events
    .filter((event): event is Extract<DagRunEvent, { type: typeof type }> => event.type === type)
    .map((event) => event.nodeIds.map(String))
}

describe("DAG scheduler failure semantics", () => {
  test("#given every terminal task status #when folded #then each maps to its exact node outcome and error code", async () => {
    // given
    const cases = [
      { status: "completed", state: "completed", code: undefined },
      { status: "error", state: "failed", code: "task_error" },
      { status: "interrupted", state: "failed", code: "task_interrupted" },
      { status: "lost", state: "failed", code: "task_lost" },
      { status: "cancelled", state: "failed", code: "task_cancelled" },
    ] as const

    for (const outcome of cases) {
      const manager = new FakeTaskManager({ autoComplete: false })
      const { scheduler } = schedulerFixture(definition([node(`task-${outcome.status}`)]), manager)
      const running = scheduler.run()
      await manager.whenStarted(`task-${outcome.status}`)

      // when
      manager.complete(`task-${outcome.status}`, outcome.status)
      const result = await running

      // then
      expect(result.nodes[0]?.state).toBe(outcome.state)
      expect(result.nodes[0]?.error?.code).toBe(outcome.code)
    }
  })

  test("#given every start denial #when admission fails #then each maps to its exact node error code", async () => {
    // given
    const expected = {
      plan: "plan_unresolved",
      depth: "depth_denied",
      start: "start_failed",
      residency: "residency_denied",
    } as const
    const manager = new FakeTaskManager({
      residencyLimit: 0,
      startFailureKinds: { plan: "plan_unresolved", depth: "depth_denied", start: "start_failed" },
    })
    const { scheduler } = schedulerFixture(definition(Object.keys(expected).map((id) => node(id))), manager)

    // when
    const result = await scheduler.run()

    // then
    expect(Object.fromEntries(result.nodes.map((entry) => [entry.id, entry.error?.code]))).toEqual(expected)
  })

  test("#given a failed root with a descendant chain #when failure cascades #then every descendant skip is persisted separately", async () => {
    // given
    const manager = new FakeTaskManager({ startFailureNodeIds: ["root"] })
    const { scheduler, events } = schedulerFixture(
      definition([node("root"), node("child", ["root"]), node("grandchild", ["child"]), node("independent")]),
      manager,
    )

    // when
    const result = await scheduler.run()

    // then
    expect(result.nodes.map((entry) => `${entry.id}:${entry.state}`)).toEqual([
      "root:failed",
      "child:skipped",
      "grandchild:skipped",
      "independent:completed",
    ])
    const skipEvents = events().filter((event): event is Extract<DagRunEvent, { type: "dag.node.transitioned" }> =>
      event.type === "dag.node.transitioned" && event.to === "skipped",
    )
    expect(skipEvents.map((event) => String(event.nodeId))).toEqual(["child", "grandchild"])
    expect(new Set(skipEvents.map((event) => event.seq)).size).toBe(2)
  })

  test("#given graph-ordered failures finish out of order #when independent work settles #then the run uses the first wave and declaration failure", async () => {
    // given
    const manager = new FakeTaskManager({ autoComplete: false })
    const { scheduler, events } = schedulerFixture(
      definition([
        node("later-wave", ["preparation"]),
        node("graph-first"),
        node("completion-first"),
        node("preparation"),
      ]),
      manager,
    )
    const running = scheduler.run()
    await Promise.all([
      manager.whenStarted("graph-first"),
      manager.whenStarted("completion-first"),
      manager.whenStarted("preparation"),
    ])

    // when
    manager.complete("completion-first", "error")
    manager.complete("preparation")
    manager.complete("graph-first", "error")
    await manager.whenStarted("later-wave")
    manager.complete("later-wave", "error")
    const result = await running

    // then
    expect(result.status).toBe("failed")
    const failedEvent = events().find((event) => event.type === "dag.run.failed")
    expect(failedEvent).toEqual(expect.objectContaining({ error: expect.objectContaining({ nodeId: "graph-first" }) }))
  })
})

describe("DAG scheduler strict wave barrier", () => {
  test("#given a linear three-wave DAG #when run #then nodes and wave events are admitted in order", async () => {
    // given
    const manager = new FakeTaskManager()
    const { scheduler, events } = schedulerFixture(definition([node("a"), node("b", ["a"]), node("c", ["b"])]), manager)

    // when
    const result = await scheduler.run()

    // then
    expect(manager.starts).toEqual(["a", "b", "c"])
    expect(waveMembership(events(), "dag.wave.started")).toEqual([["a"], ["b"], ["c"]])
    expect(waveMembership(events(), "dag.wave.completed")).toEqual([["a"], ["b"], ["c"]])
    expect(result.nodes.map((entry) => `${entry.id}:${entry.state}`)).toEqual(["a:completed", "b:completed", "c:completed"])
  })

  test("#given a diamond DAG #when run #then the fan-out shares one wave and the join waits for it", async () => {
    // given
    const manager = new FakeTaskManager()
    const { scheduler, events } = schedulerFixture(
      definition([node("a"), node("b", ["a"]), node("c", ["a"]), node("d", ["b", "c"])]),
      manager,
    )

    // when
    await scheduler.run()

    // then
    expect(waveMembership(events(), "dag.wave.started")).toEqual([["a"], ["b", "c"], ["d"]])
    expect(manager.starts).toEqual(["a", "b", "c", "d"])
  })

  test("#given a wave-one task is still running #when the scheduler is active #then wave two is not admitted before terminal", async () => {
    // given
    const manager = new FakeTaskManager({ autoComplete: false })
    const { scheduler } = schedulerFixture(definition([node("a"), node("b", ["a"])]), manager)
    const aStarted = manager.whenStarted("a")
    const bStarted = manager.whenStarted("b")

    // when
    const running = scheduler.run()
    await aStarted

    // then
    expect(manager.starts).toEqual(["a"])
    manager.complete("a")
    await bStarted
    expect(manager.starts).toEqual(["a", "b"])
    manager.complete("b")
    await running
  })

  test("#given one root start fails #when its wave is admitted #then siblings and the independent branch still run", async () => {
    // given
    const manager = new FakeTaskManager({ startFailureNodeIds: ["b"] })
    const { scheduler, events } = schedulerFixture(
      definition([node("a"), node("b"), node("c", ["a"]), node("d", ["b"])]),
      manager,
    )

    // when
    const result = await scheduler.run()

    // then
    expect(manager.starts).toEqual(["a", "c"])
    expect(manager.attempts.slice(0, 2)).toEqual(["a", "b"])
    expect(result.nodes.map((entry) => `${entry.id}:${entry.state}`)).toEqual([
      "a:completed",
      "b:failed",
      "c:completed",
      "d:skipped",
    ])
    expect(waveMembership(events(), "dag.wave.started")).toEqual([["a", "b"], ["c"]])
  })

  test("#given startOwned queues a scheduled node #when attached #then its queue position is journaled", async () => {
    // given
    const manager = new FakeTaskManager({ queuedNodeIds: ["a"] })
    const { scheduler, events } = schedulerFixture(definition([node("a")]), manager)

    // when
    await scheduler.run()

    // then
    expect(events()).toContainEqual(expect.objectContaining({
      type: "dag.node.transitioned",
      nodeId: "a",
      from: "scheduled",
      to: "scheduled",
      reason: { kind: "task_queued", queuePosition: 3 },
    }))
  })

  test("#given a same-wave node is residency denied #when an attached sibling frees a slot #then admission retries without failing it", async () => {
    // given
    const manager = new FakeTaskManager({ residencyLimit: 1, autoComplete: false })
    const { scheduler, events } = schedulerFixture(definition([node("a"), node("b")]), manager)
    const aStarted = manager.whenStarted("a")
    const bStarted = manager.whenStarted("b")

    // when
    const running = scheduler.run()
    await aStarted
    expect(manager.attempts).toEqual(["a", "b"])
    manager.complete("a")
    await bStarted

    // then
    expect(manager.attempts).toEqual(["a", "b", "b"])
    expect(events().filter((event) => event.type === "dag.node.transitioned" && event.nodeId === "b" && event.to === "failed")).toEqual([])
    manager.complete("b")
    const result = await running
    expect(result.nodes.find((entry) => entry.id === "b")?.state).toBe("completed")
  })

  test("#given a wave wider than residency capacity #when tasks settle #then all nodes are admitted in batches without a second concurrency limit", async () => {
    // given
    const manager = new FakeTaskManager({ residencyLimit: 2 })
    const { scheduler } = schedulerFixture(definition([node("a"), node("b"), node("c"), node("d"), node("e")]), manager)

    // when
    const result = await scheduler.run()

    // then
    expect(manager.starts).toEqual(["a", "b", "c", "d", "e"])
    expect(manager.residencyDenials.length).toBeGreaterThan(0)
    expect(manager.maxResidents).toBe(2)
    expect(result.nodes.every((entry) => entry.state === "completed")).toBe(true)
  })
})
