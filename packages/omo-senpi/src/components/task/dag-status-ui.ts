import { excerptRendererText, normalizeRendererText } from "@oh-my-opencode/senpi-task/renderer-text"

import type { CapturedUi } from "./runtime-context"

// Own widget key: the DAG rows render BESIDE the existing "omo-task" widget, never over it.
export const DAG_STATUS_UI_KEY = "omo-dag"
const DEFAULT_DEBOUNCE_MS = 250
const LIVE_REFRESH_MS = 1_000
const MAX_NODE_ROWS = 12
const ACTIVITY_MAX = 40
const LABEL_MAX = 32

type TimerHandle = ReturnType<typeof setTimeout> | number

// Structural mirrors of the dag domain contract (senpi-task/src/dag/types.ts). Declared locally so
// the widget stays a read-only consumer of whatever DagManager instance the extension wires in.
export type DagStatusRoute =
  | { readonly kind: "category"; readonly category: string }
  | { readonly kind: "agent"; readonly agent: string; readonly model?: string }

export interface DagStatusNode {
  readonly id: string
  readonly label?: string
  readonly state: string
  readonly route: DagStatusRoute
  readonly dependsOn: readonly string[]
}

export interface DagStatusWave {
  readonly index: number
  readonly nodeIds: readonly string[]
}

export interface DagStatusRunSnapshot {
  readonly runId: string
  readonly name: string
  readonly status: string
  readonly nodes: readonly DagStatusNode[]
  readonly waves: readonly DagStatusWave[]
}

export interface DagStatusRunSummary {
  readonly runId: string
  readonly status: string
}

// The unsequenced live telemetry feed (DagActivityEvent): latest-wins per node, never accumulated.
export interface DagStatusActivityEvent {
  readonly runId: string
  readonly nodeId: string
  readonly taskId: string
  readonly activity: string
  readonly turns: number
}

// The read seam the widget needs from DagManager: session-scoped run list plus per-run snapshot.
export interface DagStatusUiManager {
  list(parentSessionId: string, options?: { readonly limit?: number }): readonly DagStatusRunSummary[]
  snapshot(runId: string, parentSessionId: string): DagStatusRunSnapshot
}

export interface DagStatusUiRuntime {
  ui(): CapturedUi | undefined
  sessionId(): string | undefined
  mode(): string | undefined
}

// Injectable timer seam so debounce and live refresh are deterministic under test.
export interface DagStatusUiTimers {
  set(callback: () => void, ms: number): TimerHandle
  clear(handle: TimerHandle): void
}

export interface DagStatusUiDeps {
  readonly manager: DagStatusUiManager
  readonly runtime: DagStatusUiRuntime
  readonly debounceMs?: number
  readonly timers?: DagStatusUiTimers
}

export interface DagStatusUi {
  // Debounced render, driven by dag events; collapses a burst into one paint.
  scheduleSync(): void
  // Immediate render.
  syncNow(): void
  // Live activity feed intake: latest-wins per node, ignored for runs this session cannot see.
  onActivity(event: DagStatusActivityEvent): void
  // Cancel pending timers so shutdown leaves no render scheduled past teardown.
  dispose(): void
}

const globalTimers: DagStatusUiTimers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle),
}

const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"])
const TERMINAL_NODE_STATES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled", "skipped"])

const NODE_ICONS: Readonly<Record<string, string>> = {
  running: "▶",
  completed: "✓",
  failed: "✗",
  skipped: "⊘",
  cancelled: "⊘",
  paused: "⏸",
}

export function createDagStatusUi(deps: DagStatusUiDeps): DagStatusUi {
  const timers = deps.timers ?? globalTimers
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS
  // runId -> nodeId -> latest activity text. Latest-wins: an entry is replaced, never appended to.
  const liveActivity = new Map<string, Map<string, string>>()
  let pending: TimerHandle | undefined
  let liveRefresh: TimerHandle | undefined

  function render(): void {
    const ui = deps.runtime.ui()
    // TUI only: setWidget is a no-op in app-server mode, so skip the work entirely there.
    if (ui === undefined || deps.runtime.mode() !== "tui") {
      clearLiveRefresh()
      return
    }
    const runs = liveRuns()
    const rows = runs.flatMap((run) => runRows(run, liveActivity.get(run.runId)))
    pruneActivity(runs)
    if (rows.length === 0) {
      clearLiveRefresh()
      ui.setWidget(DAG_STATUS_UI_KEY, undefined)
      return
    }
    ui.setWidget(DAG_STATUS_UI_KEY, rows, { placement: "belowEditor" })
    if (runs.some((run) => !TERMINAL_RUN_STATUSES.has(run.status))) scheduleLiveRefresh()
    else clearLiveRefresh()
  }

  function liveRuns(): readonly DagStatusRunSnapshot[] {
    const sessionId = deps.runtime.sessionId()
    // Fail-closed: without a session id there is nothing to scope, so no run is queried.
    if (sessionId === undefined) return []
    const snapshots: DagStatusRunSnapshot[] = []
    for (const summary of deps.manager.list(sessionId)) {
      if (TERMINAL_RUN_STATUSES.has(summary.status)) continue
      // A run pruned between list and snapshot is stale, not fatal: drop it and keep painting.
      const snapshot = readSnapshot(summary.runId, sessionId)
      if (snapshot === undefined) continue
      snapshots.push(snapshot)
    }
    return snapshots
  }

  function readSnapshot(runId: string, sessionId: string): DagStatusRunSnapshot | undefined {
    try {
      return deps.manager.snapshot(runId, sessionId)
    } catch {
      return undefined
    }
  }

  function pruneActivity(runs: readonly DagStatusRunSnapshot[]): void {
    const liveIds = new Set(runs.map((run) => run.runId))
    for (const runId of [...liveActivity.keys()]) {
      if (!liveIds.has(runId)) liveActivity.delete(runId)
    }
  }

  function scheduleSync(): void {
    // A live run already repaints at 1Hz; reuse that timer rather than stacking a second one.
    if (liveRefresh !== undefined) return
    if (pending !== undefined) timers.clear(pending)
    pending = timers.set(() => {
      pending = undefined
      render()
    }, debounceMs)
  }

  function scheduleLiveRefresh(): void {
    if (liveRefresh !== undefined) return
    const handle = timers.set(() => {
      if (liveRefresh !== handle) return
      liveRefresh = undefined
      render()
    }, LIVE_REFRESH_MS)
    liveRefresh = handle
  }

  function clearLiveRefresh(): void {
    if (liveRefresh === undefined) return
    timers.clear(liveRefresh)
    liveRefresh = undefined
  }

  return {
    scheduleSync,
    syncNow: render,
    onActivity(event) {
      const perRun = liveActivity.get(event.runId) ?? new Map<string, string>()
      perRun.set(event.nodeId, event.activity)
      liveActivity.set(event.runId, perRun)
      scheduleSync()
    },
    dispose() {
      if (pending !== undefined) {
        timers.clear(pending)
        pending = undefined
      }
      clearLiveRefresh()
      liveActivity.clear()
    },
  }
}

function runRows(run: DagStatusRunSnapshot, activity: ReadonlyMap<string, string> | undefined): string[] {
  const rows = [runHeaderRow(run)]
  const shown = run.nodes.slice(0, MAX_NODE_ROWS)
  for (const node of shown) rows.push(nodeRow(node, activity))
  const overflow = run.nodes.length - shown.length
  if (overflow > 0) rows.push(`  +${overflow} more`)
  return rows
}

function runHeaderRow(run: DagStatusRunSnapshot): string {
  const icon = NODE_ICONS[run.status] ?? "○"
  const name = excerptRendererText(normalizeRendererText(run.name), LABEL_MAX)
  return `${icon} ${name} ${normalizeRendererText(run.status)} ${waveLabel(run)} ${countsLabel(run)}`
}

// Current wave = the first wave still holding a nonterminal node; a fully settled run reads y/y.
function waveLabel(run: DagStatusRunSnapshot): string {
  const total = run.waves.length
  if (total === 0) return "wave 0/0"
  const states = new Map(run.nodes.map((node) => [node.id, node.state] as const))
  const openIndex = run.waves.findIndex((wave) =>
    wave.nodeIds.some((nodeId) => !TERMINAL_NODE_STATES.has(states.get(nodeId) ?? "pending")),
  )
  const current = openIndex === -1 ? total : openIndex + 1
  return `wave ${current}/${total}`
}

function countsLabel(run: DagStatusRunSnapshot): string {
  let completed = 0
  let running = 0
  let failed = 0
  for (const node of run.nodes) {
    if (node.state === "completed") completed += 1
    else if (node.state === "running") running += 1
    else if (node.state === "failed") failed += 1
  }
  const tokens = [`${completed}/${run.nodes.length} done`]
  if (running > 0) tokens.push(`${running} running`)
  if (failed > 0) tokens.push(`${failed} failed`)
  return tokens.join(", ")
}

function nodeRow(node: DagStatusNode, activity: ReadonlyMap<string, string> | undefined): string {
  const icon = NODE_ICONS[node.state] ?? "○"
  const label = excerptRendererText(normalizeRendererText(node.label ?? node.id), LABEL_MAX)
  const parts = [`  ${icon}`, label, routeLabel(node.route)]
  // Activity is live telemetry: it belongs to a running node only, never to a settled one.
  const live = node.state === "running" ? activity?.get(node.id) : undefined
  if (live !== undefined) parts.push(excerptRendererText(normalizeRendererText(live), ACTIVITY_MAX))
  return parts.join(" ")
}

function routeLabel(route: DagStatusRoute): string {
  if (route.kind === "agent") {
    const agent = normalizeRendererText(route.agent)
    return route.model === undefined ? `agent:${agent}` : `agent:${agent}(${normalizeRendererText(route.model)})`
  }
  return `category:${normalizeRendererText(route.category)}`
}
