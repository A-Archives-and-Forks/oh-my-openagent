import type { SenpiExtensionAPI } from "../../extension/types"

// The three DAG channels. The sequenced ledger and the unsequenced telemetry stay separate on the
// wire: an unsequenced payload on the ledger channel breaks viewer catch-up, which dedupes on seq.
const DAG_EVENT_CHANNEL = "omo.dag.event"
const DAG_HEARTBEAT_CHANNEL = "omo.dag.heartbeat"
const DAG_ACTIVITY_CHANNEL = "omo.dag.activity"

export const DAG_DEFAULT_HEARTBEAT_MS = 15000
export const DAG_ACTIVITY_COALESCE_MS = 150

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
  readonly heartbeatMs?: number
  readonly activityCoalesceMs?: number
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
  dispose(): void
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
  const subscriptions = new Map<string, () => void>()
  const headSeq = new Map<string, number>()
  const pendingActivity = new Map<string, DagBridgeActivityEvent>()
  let heartbeat: TimerHandle | undefined
  let activityFlush: TimerHandle | undefined
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

  const detach = (): void => {
    attached = false
    for (const unsubscribe of subscriptions.values()) unsubscribe()
    subscriptions.clear()
    headSeq.clear()
    pendingActivity.clear()
    stopHeartbeat()
    stopActivityFlush()
  }

  const sync = (): void => {
    if (!attached) return
    for (const run of deps.liveRuns()) {
      if (subscriptions.has(run.runId)) continue
      subscriptions.set(run.runId, run.subscribe(forward))
    }
    scheduleHeartbeat()
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
