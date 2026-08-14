// allow: SIZE_OK - this is the DAG composition root: one manager/store graph must be shared by the
// tool, scheduler, RPC, TUI, wake, and lifecycle adapters or live runs split into isolated islands.
import type { TaskManager, TaskRecord } from "@oh-my-opencode/senpi-task"
import {
  createDagFileStore,
  createDagManager,
  createDagRecovery,
  createDagScheduler,
  createDagWaitSurface,
  type DagFileStore,
  type DagManager,
  type DagRunEvent,
  type DagRunId,
  type DagRunRecordV1,
  type DagScheduler,
  type OwnedStartResult,
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
const SCHEDULABLE_RUN_STATUSES = new Set(["pending", "running"])
export interface DagRuntime {
  readonly manager: DagManager
  readonly wait: ReturnType<typeof createDagWaitSurface>["wait"]
  readonly cancel: (runId: DagRunId, reason?: string) => Promise<void>
  readonly taskRecord: (taskId: string) => TaskRecord | undefined
  attach(): Promise<void>
  sync(): void
  detach(): void
  pauseForShutdown(): void
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
  const schedulers = new Map<DagRunId, { readonly scheduler: DagScheduler; running?: Promise<DagRunRecordV1> }>()
  const stoppedAdmissions = new Set<DagRunId>()
  const recoveryTaskSubscriptions = new Map<string, () => void>()
  let mutationListener = (): void => undefined
  let durableEventListener = (_event: DagRunEvent): void => undefined
  let activeSessionId: string | undefined

  const store: DagFileStore = {
    ...baseStore,
    writeCheckpoint(runId, checkpoint) {
      baseStore.writeCheckpoint(runId, checkpoint)
      mutationListener()
      publishDurableEvents(baseStore, runId, deliveredSeq, runListeners, durableEventListener)
    },
  }
  const coreManager = createDagManager({
    store,
    ...(dagSettings === undefined ? {} : { settings: dagSettings }),
  })
  const taskManager = admissionTaskManager(
    deps.engine.manager,
    (runId) => stoppedAdmissions.has(runId),
  )

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
      scheduler: createDagScheduler({
        store,
        taskManager,
        initialRecord,
        executionMode: { agents: deps.engine.agents, config: deps.engine.omoConfig },
      }),
    }
    schedulers.set(runId, created)
    return created
  }

  const ensureScheduled = (runId: DagRunId, parentSessionId: string): void => {
    const initialRecord = coreManager.record(runId, parentSessionId)
    if (!SCHEDULABLE_RUN_STATUSES.has(initialRecord.status)) return
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
    const record = baseStore.readCheckpoint<DagRunRecordV1>(event.runId)
    if (record === null || record.parentSessionId !== activeSessionId) return
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

  const recovery = createDagRecovery({
    store,
    taskManager,
    stopAdmission: (runId) => stoppedAdmissions.add(runId),
    reattach: (runId, taskId) => {
      const key = `${runId}\0${taskId}`
      if (recoveryTaskSubscriptions.has(key)) return
      recoveryTaskSubscriptions.set(key, deps.engine.manager.subscribeChild(taskId, () => mutationListener()))
    },
  })

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
    async attach() {
      activeSessionId = deps.engine.runtime.sessionId()
      durableEventListener = onEvent
      bridge.attach()
      const sessionId = activeSessionId
      if (sessionId !== undefined) {
        try {
          await recovery.resumePausedRuns(sessionId)
        } finally {
          clearSubscriptions(recoveryTaskSubscriptions)
        }
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
      durableEventListener = () => undefined
      const detachedListeners = new Map([...runListeners].map(([runId, listeners]) => [runId, new Set(listeners)]))
      const stopping = [...schedulers].map(([runId, owned]) =>
        owned.scheduler.cancel(runId, "runtime detached"),
      )
      void Promise.allSettled(stopping).then(() => removeListeners(runListeners, detachedListeners))
      clearSubscriptions(recoveryTaskSubscriptions)
      bridge.detach()
      activeSessionId = undefined
      statusUi.dispose()
    },
    pauseForShutdown() {
      const sessionId = activeSessionId ?? deps.engine.runtime.sessionId()
      if (sessionId !== undefined) recovery.pauseRunsForShutdown(sessionId)
    },
    dispose() {
      bridge.dispose()
      activeSessionId = undefined
      statusUi.dispose()
      wakeSource.emitShutdown()
      clearSubscriptions(recoveryTaskSubscriptions)
      runListeners.clear()
    },
  }
  return runtime
}

function admissionTaskManager(
  manager: TaskManager,
  admissionStopped: (runId: DagRunId) => boolean,
): TaskManager {
  return new Proxy(manager, {
    get(target, property) {
      if (property === "startOwned") {
        return (spec: Parameters<TaskManager["startOwned"]>[0], owner: Parameters<TaskManager["startOwned"]>[1]) => {
          if (admissionStopped(owner.runId)) return stoppedAdmission()
          return target.startOwned({ ...spec, run_in_background: false }, owner)
        }
      }
      const value: unknown = Reflect.get(target, property, target)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}

function stoppedAdmission(): Promise<OwnedStartResult> {
  return new Promise<OwnedStartResult>(() => undefined)
}

function removeListeners(
  listeners: Map<DagRunId, Set<(event: DagRunEvent) => void>>,
  removing: ReadonlyMap<DagRunId, ReadonlySet<(event: DagRunEvent) => void>>,
): void {
  for (const [runId, stale] of removing) {
    const current = listeners.get(runId)
    if (current === undefined) continue
    for (const listener of stale) current.delete(listener)
    if (current.size === 0) listeners.delete(runId)
  }
}

function clearSubscriptions(subscriptions: Map<string, () => void>): void {
  for (const unsubscribe of subscriptions.values()) unsubscribe()
  subscriptions.clear()
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
      deliverDurableEvent(onEvent, event)
      for (const listener of listeners.get(runId) ?? []) deliverDurableEvent(listener, event)
    }
    if (!page.hasMore) return
    sinceSeq = page.nextSinceSeq
  }
}

function deliverDurableEvent(listener: (event: DagRunEvent) => void, event: DagRunEvent): void {
  try {
    listener(event)
  } catch (error) {
    console.error("DAG runtime subscriber failed", error)
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
