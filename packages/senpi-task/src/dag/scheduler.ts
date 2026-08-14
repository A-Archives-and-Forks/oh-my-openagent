// allow: SIZE_OK - the admission loop, event reducer, and task outcome folding stay together so the strict barrier cannot be bypassed by callers.
import type { ManagerStartSpec, TaskManager } from "../manager/types"
import type { TaskRecord, TaskStatus } from "../state"
import { dagFingerprint } from "./fingerprint"
import {
  dagNodeTaskAttachedEvent,
  dagNodeTransitionedEvent,
  dagRunCancelledEvent,
  dagRunCompletedEvent,
  dagRunFailedEvent,
  dagRunStartedEvent,
  dagWaveCompletedEvent,
  dagWaveStartedEvent,
} from "./events"
import { createDagJournal, type DagJournal, type DagJournalListener } from "./journal"
import type { DagPersistedNode, DagRunRecordV1 } from "./manager"
import type { OwnedStartResult } from "./owner"
import type { DagFileStore } from "./store"
import type {
  DagNode,
  DagNodeCounts,
  DagNodeError,
  DagNodeErrorCode,
  DagNodeId,
  DagNodeState,
  DagNodeTransitionReason,
  DagRunEvent,
  DagRunId,
} from "./types"

const TERMINAL_NODE_STATES: ReadonlySet<DagNodeState> = new Set([
  "completed",
  "failed",
  "cancelled",
  "skipped",
])

export type DagSchedulerOptions = {
  readonly store: DagFileStore
  readonly taskManager: TaskManager
  readonly initialRecord: DagRunRecordV1
  readonly now?: () => number
}

export type DagScheduler = {
  readonly run: () => Promise<DagRunRecordV1>
  readonly cancel: (runId: DagRunId, reason?: string) => Promise<void>
  readonly snapshot: () => DagRunRecordV1
  readonly subscribe: (listener: DagJournalListener) => () => void
}

type AttachedTask = {
  readonly nodeId: DagNodeId
  readonly settled: Promise<{ readonly nodeId: DagNodeId; readonly record: TaskRecord }>
}

type SchedulerContext = {
  readonly taskManager: TaskManager
  readonly journal: DagJournal<DagRunRecordV1>
  readonly definitionNodes: ReadonlyMap<DagNodeId, DagPersistedNode>
  readonly now: () => number
  readonly pendingErrors: Map<DagNodeId, DagNodeError>
  readonly attachedTaskIds: Map<DagNodeId, string>
  readonly cancellationRequested: Promise<void>
  readonly resolveCancellationRequested: () => void
  readonly cancellationCompleted: Promise<void>
  readonly resolveCancellationCompleted: () => void
  cancellationStarted: boolean
  cancellationOperation?: Promise<void>
  admissionInProgress: boolean
  readonly admissionIdleWaiters: Set<() => void>
}

export function createDagScheduler(options: DagSchedulerOptions): DagScheduler {
  const now = options.now ?? Date.now
  const pendingErrors = new Map<DagNodeId, DagNodeError>()
  const cancellationRequested = deferredSignal()
  const cancellationCompleted = deferredSignal()
  const journal = createDagJournal<DagRunRecordV1>({
    store: options.store,
    runId: options.initialRecord.runId,
    initialCheckpoint: options.initialRecord,
    applyEvent: (record, event) => applyDagSchedulerEvent(record, event, pendingErrors),
    now,
  })
  const context: SchedulerContext = {
    taskManager: options.taskManager,
    journal,
    definitionNodes: new Map(options.initialRecord.definition.nodes.map((node) => [node.id as DagNodeId, node])),
    now,
    pendingErrors,
    attachedTaskIds: new Map(),
    cancellationRequested: cancellationRequested.promise,
    resolveCancellationRequested: cancellationRequested.resolve,
    cancellationCompleted: cancellationCompleted.promise,
    resolveCancellationCompleted: cancellationCompleted.resolve,
    cancellationStarted: false,
    admissionInProgress: false,
    admissionIdleWaiters: new Set(),
  }

  return {
    run: () => runWaves(context),
    cancel: (runId, reason) => cancelRun(context, runId, reason),
    snapshot: journal.snapshot,
    subscribe: journal.subscribe,
  }
}

export function applyDagSchedulerEvent(
  record: DagRunRecordV1,
  event: DagRunEvent,
  pendingErrors: ReadonlyMap<DagNodeId, DagNodeError> = new Map(),
): DagRunRecordV1 {
  switch (event.type) {
    case "dag.run.started":
      return {
        ...record,
        status: "running",
        startedAt: record.startedAt ?? event.at,
        updatedAt: event.at,
      }
    case "dag.run.completed":
      return { ...record, status: "completed", completedAt: event.at, updatedAt: event.at }
    case "dag.run.failed":
      return { ...record, status: "failed", completedAt: event.at, updatedAt: event.at }
    case "dag.run.cancelled":
      return { ...record, status: "cancelled", completedAt: event.at, updatedAt: event.at }
    case "dag.node.transitioned":
      return {
        ...record,
        nodes: record.nodes.map((node) => node.id === event.nodeId
          ? transitionedNode(node, event.to, event.at, pendingErrors.get(event.nodeId))
          : node),
        updatedAt: event.at,
      }
    case "dag.node.task-attached":
      return {
        ...record,
        nodes: record.nodes.map((node) => node.id === event.nodeId
          ? { ...node, taskId: event.taskId, attempt: event.attempt }
          : node),
        updatedAt: event.at,
      }
    default:
      return { ...record, updatedAt: event.at }
  }
}

async function cancelRun(context: SchedulerContext, runId: DagRunId, reason?: string): Promise<void> {
  const snapshot = context.journal.snapshot()
  if (snapshot.runId !== runId) throw new Error(`scheduler does not own DAG run "${runId}"`)
  if (snapshot.status === "completed" || snapshot.status === "failed" || snapshot.status === "cancelled") return
  if (context.cancellationOperation !== undefined) return context.cancellationOperation

  context.cancellationStarted = true
  context.resolveCancellationRequested()
  context.cancellationOperation = performCancellation(context, reason)
  return context.cancellationOperation
}

async function performCancellation(context: SchedulerContext, reason?: string): Promise<void> {
  try {
    await whenAdmissionIdle(context)
    await Promise.allSettled([...context.attachedTaskIds.values()].map((taskId) =>
      context.taskManager.cancelTask(taskId, reason),
    ))
    const cancelledNodeIds: DagNodeId[] = []
    for (const node of context.journal.snapshot().nodes) {
      if (TERMINAL_NODE_STATES.has(node.state)) continue
      transition(context, node.id, "cancelled", { kind: "cancelled" })
      cancelledNodeIds.push(node.id)
    }
    const cancelled = context.journal.snapshot()
    context.journal.append(Object.assign(
      dagRunCancelledEvent({ reason, counts: countNodes(cancelled.nodes) }),
      { cancelledNodeIds },
    ))
    context.attachedTaskIds.clear()
  } finally {
    context.resolveCancellationCompleted()
  }
}

async function cancelledSnapshot(context: SchedulerContext): Promise<DagRunRecordV1> {
  await context.cancellationCompleted
  return context.journal.snapshot()
}

function whenAdmissionIdle(context: SchedulerContext): Promise<void> {
  if (!context.admissionInProgress) return Promise.resolve()
  return new Promise<void>((resolve) => context.admissionIdleWaiters.add(resolve))
}

function resolveAdmissionIdle(context: SchedulerContext): void {
  for (const resolve of context.admissionIdleWaiters) resolve()
  context.admissionIdleWaiters.clear()
}

async function runWaves(context: SchedulerContext): Promise<DagRunRecordV1> {
  if (context.journal.snapshot().status === "pending") {
    context.journal.append(dagRunStartedEvent({ generation: context.journal.snapshot().generation }))
  }

  for (const wave of context.journal.snapshot().waves) {
    if (context.cancellationStarted) return cancelledSnapshot(context)
    applyDependentSkipCascade(context)
    const runnable = wave.nodeIds.filter((nodeId) => isRunnable(context.journal.snapshot(), nodeId))
    if (runnable.length === 0) continue

    for (const nodeId of runnable) transition(context, nodeId, "scheduled", { kind: "scheduled" })
    context.journal.append(dagWaveStartedEvent({ waveIndex: wave.index, nodeIds: runnable }))
    if (!await admitAndSettleWave(context, runnable)) return cancelledSnapshot(context)
    context.journal.append(dagWaveCompletedEvent({ waveIndex: wave.index, nodeIds: runnable }))
  }

  applyDependentSkipCascade(context)
  const snapshot = context.journal.snapshot()
  const failed = primaryFailure(snapshot)
  if (failed !== undefined) {
    const error = failed.error ?? nodeError(failed.id, "start_failed", "DAG node failed", context.now)
    context.journal.append(dagRunFailedEvent({ error, counts: countNodes(snapshot.nodes) }))
  } else {
    context.journal.append(dagRunCompletedEvent({ counts: countNodes(snapshot.nodes) }))
  }
  return context.journal.snapshot()
}

async function admitAndSettleWave(context: SchedulerContext, nodeIds: readonly DagNodeId[]): Promise<boolean> {
  let awaitingAdmission = [...nodeIds]
  const attached = new Map<DagNodeId, AttachedTask>()

  while (awaitingAdmission.length > 0) {
    if (context.cancellationStarted) return false
    context.admissionInProgress = true
    const results = await Promise.all(awaitingAdmission.map(async (nodeId) => ({
      nodeId,
      result: await context.taskManager.startOwned(startSpec(context, nodeId), owner(context, nodeId)),
    })))
    const denied: DagNodeId[] = []
    for (const { nodeId, result } of results) {
      if (context.cancellationStarted) {
        if (result.kind === "started") attachStarted(context, attached, nodeId, result)
      } else if (result.kind === "residency_denied") {
        denied.push(nodeId)
      } else {
        attachOrFail(context, attached, nodeId, result)
      }
    }
    context.admissionInProgress = false
    resolveAdmissionIdle(context)
    if (context.cancellationStarted) return false
    awaitingAdmission = denied
    if (awaitingAdmission.length === 0) break
    if (attached.size === 0) {
      for (const nodeId of awaitingAdmission) {
        failNode(context, nodeId, "residency_denied", "resident child cap reached and no task can free a slot")
      }
      awaitingAdmission = []
      break
    }
    await settleOne(context, attached)
  }

  while (attached.size > 0) {
    if (!await settleOne(context, attached)) return false
  }
  return true
}

function attachOrFail(
  context: SchedulerContext,
  attached: Map<DagNodeId, AttachedTask>,
  nodeId: DagNodeId,
  result: Exclude<OwnedStartResult, { readonly kind: "residency_denied" }>,
): void {
  if (result.kind !== "started") {
    const failure = startFailure(result)
    failNode(context, nodeId, failure.code, failure.message)
    return
  }

  attachStarted(context, attached, nodeId, result)
}

function attachStarted(
  context: SchedulerContext,
  attached: Map<DagNodeId, AttachedTask>,
  nodeId: DagNodeId,
  result: Extract<OwnedStartResult, { readonly kind: "started" }>,
): void {
  const node = nodeById(context.journal.snapshot(), nodeId)
  const attempt = node.attempt + 1
  context.journal.append(dagNodeTaskAttachedEvent({ nodeId, taskId: result.task_id, attempt }))
  if (result.status === "pending") {
    if (!result.reused && result.queue_position !== undefined) {
      context.journal.append({
        type: "dag.node.transitioned",
        nodeId,
        from: "scheduled",
        to: "scheduled",
        reason: { kind: "task_queued", queuePosition: result.queue_position },
      })
    }
  } else if (result.status === "running") {
    transition(context, nodeId, "running", result.reused ? { kind: "resumed" } : { kind: "started" })
  }
  context.attachedTaskIds.set(nodeId, result.task_id)
  attached.set(nodeId, {
    nodeId,
    settled: context.taskManager.waitFor(result.task_id).then((record) => ({ nodeId, record })),
  })
}

async function settleOne(context: SchedulerContext, attached: Map<DagNodeId, AttachedTask>): Promise<boolean> {
  const settled = await Promise.race([
    ...[...attached.values()].map((entry) => entry.settled),
    context.cancellationRequested.then(() => undefined),
  ])
  if (settled === undefined || context.cancellationStarted) return false
  attached.delete(settled.nodeId)
  context.attachedTaskIds.delete(settled.nodeId)
  foldTaskOutcome(context, settled.nodeId, settled.record)
  return true
}

function foldTaskOutcome(context: SchedulerContext, nodeId: DagNodeId, task: TaskRecord): void {
  if (task.status === "completed") {
    transition(context, nodeId, "completed", { kind: "succeeded" })
    return
  }
  if (task.status === "pending" || task.status === "running") {
    throw new Error(`TaskManager.waitFor returned nonterminal task ${task.task_id}`)
  }
  const failure = taskFailure(task.status, task.error_message)
  failNode(context, nodeId, failure.code, failure.message)
}

function applyDependentSkipCascade(context: SchedulerContext): void {
  let changed = true
  while (changed) {
    changed = false
    const snapshot = context.journal.snapshot()
    for (const node of snapshot.nodes) {
      if (node.state !== "pending" && node.state !== "blocked") continue
      const dependencies = node.dependsOn.map((nodeId) => nodeById(snapshot, nodeId))
      if (dependencies.some((dependency) => TERMINAL_NODE_STATES.has(dependency.state) && dependency.state !== "completed")) {
        transition(context, node.id, "skipped", { kind: "skipped" })
        changed = true
      }
    }
  }
}

function isRunnable(record: DagRunRecordV1, nodeId: DagNodeId): boolean {
  const node = nodeById(record, nodeId)
  return (node.state === "pending" || node.state === "blocked") &&
    node.dependsOn.every((dependencyId) => nodeById(record, dependencyId).state === "completed")
}

function transition(
  context: SchedulerContext,
  nodeId: DagNodeId,
  to: DagNodeState,
  reason: DagNodeTransitionReason,
): void {
  const from = nodeById(context.journal.snapshot(), nodeId).state
  context.journal.append(dagNodeTransitionedEvent({ nodeId, from, to, reason }))
}

function failNode(context: SchedulerContext, nodeId: DagNodeId, code: DagNodeErrorCode, message: string): void {
  context.pendingErrors.set(nodeId, nodeError(nodeId, code, message, context.now))
  transition(context, nodeId, "failed", { kind: "failed" })
  context.pendingErrors.delete(nodeId)
}

function startSpec(context: SchedulerContext, nodeId: DagNodeId): ManagerStartSpec {
  const record = context.journal.snapshot()
  const node = nodeById(record, nodeId)
  const persisted = context.definitionNodes.get(nodeId)
  if (persisted === undefined) throw new Error(`missing persisted definition for DAG node "${nodeId}"`)
  return {
    prompt: persisted.effectivePrompt,
    ...(persisted.task_summary === undefined ? {} : { task_summary: persisted.task_summary }),
    parent_session_id: record.parentSessionId,
    root_session_id: record.rootSessionId,
    depth: 1,
    ...(node.route.kind === "category"
      ? { category: node.route.category }
      : { subagent_type: node.route.agent, ...(node.route.model === undefined ? {} : { model: node.route.model }) }),
    name: node.id,
    ...(persisted.description === undefined ? {} : { description: persisted.description }),
    run_in_background: true,
  }
}

function owner(context: SchedulerContext, nodeId: DagNodeId) {
  const record = context.journal.snapshot()
  return {
    kind: "dag" as const,
    runId: record.runId,
    nodeId,
    fingerprint: dagFingerprint({ definitionFingerprint: record.definitionFingerprint, nodeId }),
  }
}

function startFailure(result: Exclude<OwnedStartResult, { readonly kind: "started" | "residency_denied" }>): {
  readonly code: DagNodeErrorCode
  readonly message: string
} {
  switch (result.kind) {
    case "depth_denied":
      return { code: "depth_denied", message: result.reason }
    case "plan_unresolved":
      return { code: "plan_unresolved", message: result.error.message }
    case "start_failed":
      return { code: "start_failed", message: result.error_message }
    case "owner_conflict":
      return { code: "start_failed", message: `DAG task owner conflicts with existing task ${result.task_id}` }
  }
}

function taskFailure(status: Exclude<TaskStatus, "completed" | "pending" | "running">, message?: string): {
  readonly code: DagNodeErrorCode
  readonly message: string
} {
  switch (status) {
    case "error":
      return { code: "task_error", message: message ?? "task failed" }
    case "interrupted":
      return { code: "task_interrupted", message: message ?? "task was interrupted" }
    case "lost":
      return { code: "task_lost", message: message ?? "task was lost" }
    case "cancelled":
      return { code: "task_cancelled", message: message ?? "task was cancelled" }
  }
}

function transitionedNode(node: DagNode, state: DagNodeState, at: string, error?: DagNodeError): DagNode {
  return {
    ...node,
    state,
    ...(state === "running" && node.startedAt === undefined ? { startedAt: at } : {}),
    ...(TERMINAL_NODE_STATES.has(state) ? { completedAt: at } : {}),
    ...(error === undefined ? {} : { error }),
  }
}

function nodeError(nodeId: DagNodeId, code: DagNodeErrorCode, message: string, now: () => number): DagNodeError {
  return { code, message, nodeId, at: new Date(now()).toISOString() }
}

function primaryFailure(record: DagRunRecordV1): DagNode | undefined {
  for (const wave of record.waves) {
    for (const nodeId of wave.nodeIds) {
      const node = nodeById(record, nodeId)
      if (node.state === "failed") return node
    }
  }
  return undefined
}

function nodeById(record: DagRunRecordV1, nodeId: DagNodeId): DagNode {
  const node = record.nodes.find((entry) => entry.id === nodeId)
  if (node === undefined) throw new Error(`unknown DAG node "${nodeId}"`)
  return node
}

function deferredSignal(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve = (): void => undefined
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function countNodes(nodes: readonly DagNode[]): DagNodeCounts {
  const counts = {
    total: nodes.length,
    pending: 0,
    blocked: 0,
    scheduled: 0,
    running: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    skipped: 0,
  }
  for (const node of nodes) counts[node.state] += 1
  return counts
}
