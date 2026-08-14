import type { SenpiExtensionAPI } from "../../extension/types"

// The three DAG channels. The sequenced ledger and the unsequenced telemetry stay separate on the
// wire: an unsequenced payload on the ledger channel breaks viewer catch-up, which dedupes on seq.
const DAG_EVENT_CHANNEL = "omo.dag.event"
const DAG_HEARTBEAT_CHANNEL = "omo.dag.heartbeat"
const DAG_ACTIVITY_CHANNEL = "omo.dag.activity"
// The wholesale-replace channel. It coexists with the seq ledger above: consumers that keep no
// per-event state (omo-desktop-app) swap their whole run list on each payload.
const DAG_UPDATED_CHANNEL = "omo.dag.updated"

export const DAG_DEFAULT_HEARTBEAT_MS = 15000
export const DAG_ACTIVITY_COALESCE_MS = 150
export const DAG_SNAPSHOT_DEBOUNCE_MS = 50
export const DAG_MAX_RUN_SNAPSHOTS = 256

// A run is live while it can still journal an event. Terminal runs never earn a heartbeat.
const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"])

type TimerHandle = ReturnType<typeof setTimeout> | number

// Structural read-seam over the journaled DagRunEvent. The bridge forwards the payload verbatim and
// only reads the envelope fields it needs to order and dedupe, so the 14-member payload union stays
// owned by the engine package.
export interface DagBridgeRunEvent {
  readonly schemaVersion: 1
  readonly runId: string
  readonly seq: number
  readonly at: string
  readonly lane: string
  readonly type: string
}

export interface DagBridgeActivityEvent {
  readonly schemaVersion: 1
  readonly runId: string
  readonly nodeId: string
  readonly taskId: string
  readonly at: string
  readonly activity: string
  readonly currentTool?: string
  readonly lastAssistantLine?: string
  readonly turns: number
  readonly toolCalls?: number
}

// Structural read-seam over DagRunSnapshot/DagRunSummary: the bridge reads exactly the fields it
// puts on the wire, so the engine keeps ownership of the full snapshot type.
export interface DagBridgeSnapshotNode {
  readonly id: string
  readonly label?: string
  readonly prompt: string
  readonly dependsOn: readonly string[]
  readonly state: string
  readonly taskId?: string
  readonly attempt: number
  readonly createdAt: string
  readonly startedAt?: string
  readonly completedAt?: string
}

export interface DagBridgeSnapshotEdge {
  readonly from: string
  readonly to: string
}

export interface DagBridgeSnapshotWave {
  readonly index: number
  readonly nodeIds: readonly string[]
}

export interface DagBridgeRunSnapshot {
  readonly runId: string
  readonly runKey: string
  readonly name: string
  readonly status: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly counts: Readonly<Record<string, number>>
  readonly nodes: readonly DagBridgeSnapshotNode[]
  readonly edges: readonly DagBridgeSnapshotEdge[]
  readonly waves: readonly DagBridgeSnapshotWave[]
}

// One owned run: `subscribe` is the journal fan-out, which the journal invokes only after the WAL
// append and the checkpoint replace both succeed. The bridge adds no pre-durability emission path.
export interface DagBridgeRun {
  readonly runId: string
  readonly status: string
  readonly subscribe: (listener: (event: DagBridgeRunEvent) => void) => () => void
}

// Injectable timer seam so heartbeat and activity coalescing are deterministic under test; defaults
// to global timers, mirroring `status-ui.ts`.
export interface DagBridgeTimers {
  set(callback: () => void, ms: number): TimerHandle
  clear(handle: TimerHandle): void
}

export interface DagRpcBridgeDeps {
  // Runs this session owns right now, re-read on every attach and every heartbeat tick.
  readonly liveRuns: () => readonly DagBridgeRun[]
  // Full run snapshots for the omo.dag.updated channel, re-read on every debounced flush.
  readonly runSnapshots?: () => readonly DagBridgeRunSnapshot[]
  // Routing discriminator every omo.dag.updated payload carries.
  readonly parentSessionId?: () => string | undefined
  readonly heartbeatMs?: number
  readonly activityCoalesceMs?: number
  readonly snapshotDebounceMs?: number
  readonly timers?: DagBridgeTimers
  readonly now?: () => number
}

export interface DagRpcBridge {
  // session_start: subscribe every owned run and arm the heartbeat when one is nonterminal.
  attach(): void
  // Re-read the owned runs: picks up a run started mid-session and rearms the heartbeat for it.
  sync(): void
  // session_before_switch: drop every subscription and timer so nothing leaks into the next session.
  detach(): void
  publishActivity(event: DagBridgeActivityEvent): void
  // Every dag store mutation calls this; the snapshot flush is debounced and fingerprint-deduped.
  notifyStoreMutation(): void
  dispose(): void
}

// snake_case is the wire contract omo-desktop-app already consumes for omo.task.updated; optional
// engine fields stay absent rather than serializing as null.
function runSnapshotPayload(run: DagBridgeRunSnapshot) {
  return {
    run_id: run.runId,
    run_key: run.runKey,
    name: run.name,
    status: run.status,
    created_at: run.createdAt,
    updated_at: run.updatedAt,
    counts: run.counts,
    nodes: run.nodes.map((node) => ({
      id: node.id,
      ...(node.label === undefined ? {} : { label: node.label }),
      prompt: node.prompt,
      depends_on: node.dependsOn,
      state: node.state,
      attempt: node.attempt,
      created_at: node.createdAt,
      ...(node.taskId === undefined ? {} : { task_id: node.taskId }),
      ...(node.startedAt === undefined ? {} : { started_at: node.startedAt }),
      ...(node.completedAt === undefined ? {} : { completed_at: node.completedAt }),
    })),
    edges: run.edges.map((edge) => ({ from: edge.from, to: edge.to })),
    waves: run.waves.map((wave) => ({ index: wave.index, node_ids: wave.nodeIds })),
  }
}

const globalTimers: DagBridgeTimers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle),
}

export function createDagRpcBridge(pi: SenpiExtensionAPI, deps: DagRpcBridgeDeps): DagRpcBridge {
  const timers = deps.timers ?? globalTimers
  const now = deps.now ?? Date.now
  const heartbeatMs = deps.heartbeatMs ?? DAG_DEFAULT_HEARTBEAT_MS
  const activityCoalesceMs = deps.activityCoalesceMs ?? DAG_ACTIVITY_COALESCE_MS
  const snapshotDebounceMs = deps.snapshotDebounceMs ?? DAG_SNAPSHOT_DEBOUNCE_MS
  const subscriptions = new Map<string, () => void>()
  const headSeq = new Map<string, number>()
  const pendingActivity = new Map<string, DagBridgeActivityEvent>()
  let heartbeat: TimerHandle | undefined
  let activityFlush: TimerHandle | undefined
  let snapshotFlush: TimerHandle | undefined
  let lastSnapshotFingerprint: string | undefined
  let attached = false
  let disposed = false

  const emit = (name: string, data: unknown): void => {
    pi.rpc?.emit(name, data)
  }

  const forward = (event: DagBridgeRunEvent): void => {
    if (!attached) return
    // The journal can redeliver a seq after a reopen replay; the ledger stays exactly-once per seq.
    const delivered = headSeq.get(event.runId) ?? 0
    if (event.seq <= delivered) return
    headSeq.set(event.runId, event.seq)
    emit(DAG_EVENT_CHANNEL, event)
  }

  const liveRuns = (): readonly DagBridgeRun[] =>
    deps.liveRuns().filter((run) => !TERMINAL_RUN_STATUSES.has(run.status))

  const stopHeartbeat = (): void => {
    if (heartbeat === undefined) return
    timers.clear(heartbeat)
    heartbeat = undefined
  }

  const beat = (): void => {
    heartbeat = undefined
    if (!attached) return
    const runs = liveRuns()
    if (runs.length === 0) return
    emit(DAG_HEARTBEAT_CHANNEL, {
      schemaVersion: 1,
      at: new Date(now()).toISOString(),
      runs: runs.map((run) => ({ runId: run.runId, headSeq: headSeq.get(run.runId) ?? 0 })),
    })
    scheduleHeartbeat()
  }

  const scheduleHeartbeat = (): void => {
    if (!attached || heartbeat !== undefined) return
    if (liveRuns().length === 0) return
    heartbeat = timers.set(beat, heartbeatMs)
  }

  const flushActivity = (): void => {
    activityFlush = undefined
    if (!attached) {
      pendingActivity.clear()
      return
    }
    const batch = [...pendingActivity.values()]
    pendingActivity.clear()
    // Unsequenced, never journaled, and never mixed into DAG_EVENT_CHANNEL.
    for (const event of batch) emit(DAG_ACTIVITY_CHANNEL, event)
  }

  const stopActivityFlush = (): void => {
    if (activityFlush === undefined) return
    timers.clear(activityFlush)
    activityFlush = undefined
  }

  // Wholesale snapshot, never a delta: the whole owned run set goes out on every changed flush.
  const flushSnapshot = (): void => {
    snapshotFlush = undefined
    if (!attached) return
    const parentSessionId = deps.parentSessionId?.()
    if (parentSessionId === undefined || deps.runSnapshots === undefined) return
    const all = deps.runSnapshots()
    const truncatedRuns = Math.max(0, all.length - DAG_MAX_RUN_SNAPSHOTS)
    const data = {
      parent_session_id: parentSessionId,
      runs: (truncatedRuns === 0 ? all : all.slice(0, DAG_MAX_RUN_SNAPSHOTS)).map(runSnapshotPayload),
      ...(truncatedRuns === 0 ? {} : { truncated_runs: truncatedRuns }),
    }
    const fingerprint = JSON.stringify(data)
    if (fingerprint === lastSnapshotFingerprint) return
    lastSnapshotFingerprint = fingerprint
    emit(DAG_UPDATED_CHANNEL, data)
  }

  const scheduleSnapshot = (): void => {
    if (!attached || snapshotFlush !== undefined) return
    snapshotFlush = timers.set(flushSnapshot, snapshotDebounceMs)
  }

  const stopSnapshotFlush = (): void => {
    if (snapshotFlush === undefined) return
    timers.clear(snapshotFlush)
    snapshotFlush = undefined
  }

  const detach = (): void => {
    attached = false
    for (const unsubscribe of subscriptions.values()) unsubscribe()
    subscriptions.clear()
    headSeq.clear()
    pendingActivity.clear()
    stopHeartbeat()
    stopActivityFlush()
    stopSnapshotFlush()
    // The next attach belongs to a fresh consumer, so it must receive a full snapshot again.
    lastSnapshotFingerprint = undefined
  }

  const sync = (): void => {
    if (!attached) return
    for (const run of deps.liveRuns()) {
      if (subscriptions.has(run.runId)) continue
      subscriptions.set(run.runId, run.subscribe(forward))
    }
    scheduleHeartbeat()
    scheduleSnapshot()
  }

  return {
    attach() {
      if (disposed) return
      detach()
      attached = true
      sync()
    },
    sync,
    detach,
    notifyStoreMutation() {
      if (!attached) return
      scheduleSnapshot()
    },
    publishActivity(event) {
      if (!attached) return
      // Latest-wins per node: a chatty node collapses to one payload per coalescing window.
      pendingActivity.set(`${event.runId}\u0000${event.nodeId}`, event)
      if (activityFlush === undefined) activityFlush = timers.set(flushActivity, activityCoalesceMs)
    },
    dispose() {
      if (disposed) return
      disposed = true
      detach()
    },
  }
}
