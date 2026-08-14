// allow: SIZE_OK - this is the DAG composition root: one manager/store graph must be shared by the
// tool, scheduler, RPC, TUI, wake, and lifecycle adapters or live runs split into isolated islands.
import type { TaskManager, TaskRecord } from "@oh-my-opencode/senpi-task"
import {
  createDagFileStore,
  createDagManager,
  createDagScheduler,
  createDagWaitSurface,
  persistDagNodeResult,
  type DagFileStore,
  type DagManager,
  type DagNodeId,
  type DagNodeResultArtifact,
  type DagRunEvent,
  type DagRunId,
  type DagRunRecordV1,
  type DagScheduler,
  type DagStoreDiagnostic,
} from "@oh-my-opencode/senpi-task/dag"

import type { IdleInjectionCoordinator } from "../../extension/idle-injection-coordinator"
import type { ComponentLogger, SenpiExtensionAPI } from "../../extension/types"
import { createDagRpcBridge, type DagBridgeTimers } from "./dag-rpc-bridge"
import { registerDagRpcHandlers } from "./dag-rpc-handlers"
import { createDagStatusUi, type DagStatusUiTimers } from "./dag-status-ui"
import { createDagWake } from "./dag-wake"
import { createDagWakeSource } from "./dag-wake-source"
import type { TaskEngine } from "./engine"

const EVENT_PAGE_SIZE = 1000
const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"])
const TERMINAL_NODE_STATES = new Set(["completed", "failed", "cancelled", "skipped"])

type RuntimeNodeResult =
  | { readonly kind: "persisted"; readonly artifact: DagNodeResultArtifact; readonly runStats?: TaskRecord["run_stats"] }
  | { readonly kind: "failed"; readonly diagnostic: DagStoreDiagnostic }

type RuntimeDagNode = DagRunRecordV1["nodes"][number] & {
  readonly resultArtifact?: DagNodeResultArtifact
}

type RuntimeDagRecord = Omit<DagRunRecordV1, "nodes" | "diagnostics"> & {
  readonly nodes: readonly RuntimeDagNode[]
  readonly diagnostics: readonly (DagRunRecordV1["diagnostics"][number] | DagStoreDiagnostic)[]
}

export interface DagRuntime {
  readonly manager: DagManager
  readonly wait: ReturnType<typeof createDagWaitSurface>["wait"]
  readonly cancel: (runId: DagRunId, reason?: string) => Promise<void>
  readonly taskRecord: (taskId: string) => TaskRecord | undefined
  attach(): void
  sync(): void
  detach(): void
  dispose(): void
}

export interface DagRuntimeDeps {
  readonly pi: SenpiExtensionAPI
  readonly engine: TaskEngine
  readonly logger: ComponentLogger
  readonly coordinator?: IdleInjectionCoordinator
  readonly bridgeTimers?: DagBridgeTimers
  readonly statusUiTimers?: DagStatusUiTimers
}

export function createDagRuntime(deps: DagRuntimeDeps): DagRuntime {
  const dagSettings = deps.engine.settings.dag
  const baseStore = createDagFileStore({
    project_dir: deps.engine.runtime.cwd(),
    task: {
      ...(deps.engine.settings.state_dir === undefined ? {} : { state_dir: deps.engine.settings.state_dir }),
      ...(dagSettings === undefined ? {} : { dag: dagSettings }),
    },
  })
  const runListeners = new Map<DagRunId, Set<(event: DagRunEvent) => void>>()
  const deliveredSeq = new Map<DagRunId, number>()
  const pendingResults = new Map<string, RuntimeNodeResult>()
  const schedulers = new Map<DagRunId, { readonly scheduler: DagScheduler; running?: Promise<DagRunRecordV1> }>()
  let mutationListener = (): void => undefined
  let durableEventListener = (_event: DagRunEvent): void => undefined
  let activeSessionId: string | undefined

  const store: DagFileStore = {
    ...baseStore,
    writeCheckpoint(runId, checkpoint) {
      baseStore.writeCheckpoint(runId, augmentTerminalResult(checkpoint, pendingResults))
      mutationListener()
      publishDurableEvents(baseStore, runId, deliveredSeq, runListeners, durableEventListener)
    },
  }
  const coreManager = createDagManager({
    store,
    ...(dagSettings === undefined ? {} : { settings: dagSettings }),
  })
  const taskManager = resultPersistingTaskManager(deps.engine.manager, store, pendingResults)

  const subscribe = (runId: DagRunId, listener: (event: DagRunEvent) => void): (() => void) => {
    const listeners = runListeners.get(runId) ?? new Set<(event: DagRunEvent) => void>()
    listeners.add(listener)
    runListeners.set(runId, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) runListeners.delete(runId)
    }
  }

  const controller = (runId: DagRunId, parentSessionId: string): { readonly scheduler: DagScheduler; running?: Promise<DagRunRecordV1> } => {
    const existing = schedulers.get(runId)
    if (existing !== undefined) return existing
    const initialRecord = coreManager.record(runId, parentSessionId)
    const created: { readonly scheduler: DagScheduler; running?: Promise<DagRunRecordV1> } = {
      scheduler: createDagScheduler({ store, taskManager, initialRecord }),
    }
    schedulers.set(runId, created)
    return created
  }

  const ensureScheduled = (runId: DagRunId, parentSessionId: string): void => {
    const initialRecord = coreManager.record(runId, parentSessionId)
    if (TERMINAL_RUN_STATUSES.has(initialRecord.status)) return
    const owned = controller(runId, parentSessionId)
    if (owned.running !== undefined) return
    const running = owned.scheduler.run().finally(() => schedulers.delete(runId))
    owned.running = running
    void running.catch((error: unknown) => {
      deps.logger.error("omo-senpi dag scheduler failed", {
        runId,
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }

  const manager: DagManager = {
    ...coreManager,
    async start(params) {
      const result = await coreManager.start(params)
      ensureScheduled(result.snapshot.runId, params.parentSessionId)
      return result
    },
  }

  const cancel = async (runId: DagRunId, reason?: string): Promise<void> => {
    const sessionId = deps.engine.runtime.sessionId() ?? ""
    const record = coreManager.record(runId, sessionId)
    if (TERMINAL_RUN_STATUSES.has(record.status)) return
    await controller(runId, sessionId).scheduler.cancel(runId, reason)
  }

  const waitSurface = createDagWaitSurface({ store, subscribe, cancel })
  const queryManager = {
    list: (sessionId: string, options?: { readonly limit?: number }) => manager.list(sessionId, options),
    snapshot: (runId: string, sessionId: string) => manager.snapshot(runId as DagRunId, sessionId),
    history: (params: Parameters<typeof manager.history>[0]) => manager.history(params),
  }
  const bridge = createDagRpcBridge(deps.pi, {
    liveRuns: () => runsForActiveSession(manager, deps.engine).map((summary) => ({
      runId: summary.runId,
      status: summary.status,
      subscribe: (listener) => subscribe(summary.runId, listener),
    })),
    runSnapshots: () => snapshotsForActiveSession(manager, deps.engine),
    parentSessionId: () => deps.engine.runtime.sessionId(),
    ...(dagSettings?.heartbeat_ms === undefined ? {} : { heartbeatMs: dagSettings.heartbeat_ms }),
    ...(deps.bridgeTimers === undefined ? {} : { timers: deps.bridgeTimers }),
  })
  registerDagRpcHandlers(deps.pi, { manager: queryManager, sessionId: () => activeSessionId })

  const statusUi = createDagStatusUi({
    manager: queryManager,
    runtime: deps.engine.runtime,
    ...(deps.statusUiTimers === undefined ? {} : { timers: deps.statusUiTimers }),
  })
  const wakeSource = createDagWakeSource({ pi: deps.pi, manager: queryManager, sessionId: () => deps.engine.runtime.sessionId() })
  const wake = deps.coordinator === undefined
    ? undefined
    : createDagWake({ coordinator: deps.coordinator, parentState: () => deps.engine.runtime.parentState() })
  const terminalWakeSeq = new Map<DagRunId, number>()

  const onEvent = (event: DagRunEvent): void => {
    if (event.type === "dag.run.started") wakeSource.onRunStart(event.runId)
    if (event.type !== "dag.run.completed" && event.type !== "dag.run.failed" && event.type !== "dag.run.cancelled") return
    wakeSource.onRunTerminal(event.runId)
    if ((terminalWakeSeq.get(event.runId) ?? 0) >= event.seq) return
    terminalWakeSeq.set(event.runId, event.seq)
    const sessionId = deps.engine.runtime.sessionId()
    if (sessionId === undefined) return
    const record = coreManager.record(event.runId, sessionId)
    wake?.onRunEvent(
      { runId: record.runId, name: record.name, parentSessionId: record.parentSessionId },
      {
        runId: event.runId,
        seq: event.seq,
        type: event.type,
        counts: event.counts,
        ...(event.type === "dag.run.failed" ? { error: event.error } : {}),
      },
    )
  }

  durableEventListener = onEvent
  mutationListener = () => {
    bridge.sync()
    bridge.notifyStoreMutation()
    statusUi.scheduleSync()
  }

  const runtime: DagRuntime = {
    manager,
    wait: waitSurface.wait,
    cancel,
    taskRecord: (taskId) => deps.engine.manager.get(taskId),
    attach() {
      activeSessionId = deps.engine.runtime.sessionId()
      bridge.attach()
      const sessionId = activeSessionId
      if (sessionId !== undefined) {
        for (const run of manager.list(sessionId)) ensureScheduled(run.runId, sessionId)
      }
      statusUi.syncNow()
    },
    sync() {
      bridge.sync()
      bridge.notifyStoreMutation()
      statusUi.scheduleSync()
    },
    detach() {
      bridge.detach()
      activeSessionId = undefined
      statusUi.dispose()
    },
    dispose() {
      bridge.dispose()
      activeSessionId = undefined
      statusUi.dispose()
      wakeSource.emitShutdown()
      runListeners.clear()
    },
  }
  return runtime
}

function resultPersistingTaskManager(
  manager: TaskManager,
  store: DagFileStore,
  pendingResults: Map<string, RuntimeNodeResult>,
): TaskManager {
  return new Proxy(manager, {
    get(target, property) {
      if (property === "startOwned") {
        return (spec: Parameters<TaskManager["startOwned"]>[0], owner: Parameters<TaskManager["startOwned"]>[1]) =>
          target.startOwned({ ...spec, run_in_background: false }, owner)
      }
      if (property !== "waitFor") {
        const value: unknown = Reflect.get(target, property, target)
        return typeof value === "function" ? value.bind(target) : value
      }
      return async (taskId: string, options?: { readonly signal?: AbortSignal }): Promise<TaskRecord> => {
        const record = await target.waitFor(taskId, options)
        const owner = record.owner
        if (owner?.kind !== "dag") return record
        const outcome = persistDagNodeResult({ store, runId: owner.runId, nodeId: owner.nodeId, record })
        pendingResults.set(resultKey(owner.runId, owner.nodeId), outcome.kind === "persisted"
          ? { kind: "persisted", artifact: outcome.artifact, ...(record.run_stats === undefined ? {} : { runStats: record.run_stats }) }
          : { kind: "failed", diagnostic: outcome.diagnostic })
        return record
      }
    },
  })
}

function augmentTerminalResult(checkpoint: object, pending: Map<string, RuntimeNodeResult>): object {
  if (!isDagRunRecord(checkpoint)) return checkpoint
  let changed = false
  const diagnostics = [...checkpoint.diagnostics]
  const nodes = checkpoint.nodes.map((node): RuntimeDagNode => {
    if (!TERMINAL_NODE_STATES.has(node.state)) return node
    const result = pending.get(resultKey(checkpoint.runId, node.id))
    if (result === undefined) return node
    pending.delete(resultKey(checkpoint.runId, node.id))
    changed = true
    if (result.kind === "failed") {
      diagnostics.push(result.diagnostic)
      return node
    }
    return {
      ...node,
      resultArtifact: result.artifact,
      ...(result.runStats === undefined ? {} : { runStats: result.runStats }),
    }
  })
  return changed ? { ...checkpoint, nodes, diagnostics } satisfies RuntimeDagRecord : checkpoint
}

function publishDurableEvents(
  store: DagFileStore,
  runId: DagRunId,
  delivered: Map<DagRunId, number>,
  listeners: ReadonlyMap<DagRunId, ReadonlySet<(event: DagRunEvent) => void>>,
  onEvent: (event: DagRunEvent) => void,
): void {
  let sinceSeq = delivered.get(runId) ?? 0
  for (;;) {
    const page = store.readEvents(runId, sinceSeq, { limit: EVENT_PAGE_SIZE })
    for (const event of page.events) {
      delivered.set(runId, event.seq)
      onEvent(event)
      for (const listener of listeners.get(runId) ?? []) listener(event)
    }
    if (!page.hasMore) return
    sinceSeq = page.nextSinceSeq
  }
}

function runsForActiveSession(manager: DagManager, engine: TaskEngine) {
  const sessionId = engine.runtime.sessionId()
  return sessionId === undefined ? [] : manager.list(sessionId)
}

function snapshotsForActiveSession(manager: DagManager, engine: TaskEngine) {
  const sessionId = engine.runtime.sessionId()
  if (sessionId === undefined) return []
  return manager.list(sessionId).map((run) => ({
    ...manager.snapshot(run.runId, sessionId),
    updatedAt: run.updatedAt,
  }))
}

function resultKey(runId: DagRunId, nodeId: DagNodeId): string {
  return `${runId}\0${nodeId}`
}

function isDagRunRecord(value: object): value is RuntimeDagRecord {
  return "runId" in value && "nodes" in value && Array.isArray(value.nodes) && "diagnostics" in value && Array.isArray(value.diagnostics)
}
