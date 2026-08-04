import type { TaskRecord } from "../state"
import { isSpawnSpecV1, markRecordLostForReconciliation } from "../state"
import { delay, nowIso, TERMINAL_STATUSES, type LifecycleContext } from "./context"
import { destroyResidentTask } from "./destroy"
import { getLifecycleReattachPorts, type RespawnFailureCode } from "./port"
import { admitSuspendedBatch, reclaimOrphanedResident } from "./residency"
import type { ReconcileDeferredReason, ReconcileOutcome } from "./types"

const REVIVABLE_STATUSES = new Set(["pending", "running", "completed", "error", "interrupted"])
const SUSPENDED_RESIDENCIES = new Set(["persisted_only", "rpc_detached"])
const activeLocalReclamations = new Set<string>()

type SuspendedResidency = "persisted_only" | "rpc_detached"

type RevivalCandidate = {
  readonly record: TaskRecord
  readonly priorResidency: SuspendedResidency
}

type SessionPathResolver = (taskId: string) => string | undefined

export async function reconcileScopedRevival(
  context: LifecycleContext,
  parentSessionId: string,
  records: readonly TaskRecord[],
  sessionPathFor: SessionPathResolver,
): Promise<readonly ReconcileOutcome[]> {
  if (context.config.resume_children === false) return []

  const outcomes: ReconcileOutcome[] = []
  const sessionRecords = records.filter((record) => record.parent_session_id === parentSessionId)

  // Reclamation runs first and OUTSIDE admission. These records already occupy their slot, and a
  // killed orphan can release one for the admission batch that follows.
  for (const observed of sessionRecords) {
    if (observed.residency_state !== "resident") continue
    if (!isOrphan(context, observed)) continue
    outcomes.push(await reclaimResident(context, observed, sessionPathFor))
  }

  // A terminal record without a transcript is not a revival candidate at all. Dispose it before
  // capacity selection so it neither consumes a slot nor reruns its persisted prompt.
  for (const observed of sessionRecords) {
    if (!isSuspended(observed) || !TERMINAL_STATUSES.has(observed.status) || observed.status === "lost") continue
    if (observed.killed === true || sessionPathFor(observed.task_id) !== undefined) continue
    const disposed = disposeSuspendedTerminalWithoutTranscript(context, observed)
    if (disposed) {
      outcomes.push({
        task_id: observed.task_id,
        kind: "resumed",
        reason: "terminal without transcript disposed; persisted result preserved",
      })
    }
  }

  const candidates = suspendedCandidates(context, parentSessionId)
  if (context.config.reattach_on_reconcile === false) {
    outcomes.push(...candidates.map(({ record }) => deferred(record.task_id, "reattach_disabled")))
    return outcomes
  }

  const priorResidencies = new Map(candidates.map((candidate) => [candidate.record.task_id, candidate.priorResidency]))
  const admission = await admitSuspendedBatch(context, parentSessionId, context.reconcileAdmission)
  const reported = new Set<string>()
  for (const outcome of admission.outcomes) {
    reported.add(outcome.task_id)
    if (outcome.kind === "deferred") {
      outcomes.push(deferred(outcome.task_id, outcome.reason === "lease_lost" ? "lock_contended" : outcome.reason))
      continue
    }
    const priorResidency = priorResidencies.get(outcome.task_id)
    if (priorResidency === undefined) {
      outcomes.push(deferred(outcome.task_id, "foreign_live_owner"))
      continue
    }
    const claimed = context.store.load(outcome.task_id)
    if (!isClaimHeld(context, claimed, parentSessionId)) {
      outcomes.push(deferred(outcome.task_id, "foreign_live_owner"))
      continue
    }
    outcomes.push(await reviveClaimed(context, claimed, priorResidency, sessionPathFor(claimed.task_id)))
  }
  // A concurrent sweep may claim a candidate while this sweep waits for the admission lease. The
  // fresh selector then omits it; retain one outcome per observed candidate and report the lost CAS.
  for (const candidate of candidates) {
    if (!reported.has(candidate.record.task_id)) {
      outcomes.push(deferred(candidate.record.task_id, "foreign_live_owner"))
    }
  }
  return outcomes
}

async function reclaimResident(
  context: LifecycleContext,
  observed: TaskRecord,
  sessionPathFor: SessionPathResolver,
): Promise<ReconcileOutcome> {
  const release = beginLocalReclamation(context, observed.task_id)
  if (release === undefined) return deferred(observed.task_id, "foreign_live_owner")
  try {
    return await reclaimResidentExclusive(context, observed, sessionPathFor)
  } finally {
    release()
  }
}

async function reclaimResidentExclusive(
  context: LifecycleContext,
  observed: TaskRecord,
  sessionPathFor: SessionPathResolver,
): Promise<ReconcileOutcome> {
  try {
    if (reclaimOrphanedResident(context, observed) !== "claimed") {
      return deferred(observed.task_id, "foreign_live_owner")
    }
  } catch {
    return deferred(observed.task_id, "lock_contended")
  }

  const claimed = context.store.load(observed.task_id)
  if (claimed === null || claimed.host_pid !== context.hostPid || claimed.residency_state !== "resident") {
    return deferred(observed.task_id, "foreign_live_owner")
  }

  if (claimed.killed === true || claimed.status === "cancelled" || claimed.status === "lost") {
    await destroyResidentTask(context, claimed.task_id, "reconcile_lost")
    return {
      task_id: claimed.task_id,
      kind: claimed.status === "lost" ? "lost" : "resumed",
      reason: claimed.killed === true ? "killed orphan disposed" : `${claimed.status} orphan disposed`,
    }
  }
  if (!REVIVABLE_STATUSES.has(claimed.status)) {
    await destroyResidentTask(context, claimed.task_id, "reconcile_lost")
    return { task_id: claimed.task_id, kind: "resumed", reason: "non-revivable orphan disposed" }
  }

  const sessionPath = sessionPathFor(claimed.task_id)
  if (TERMINAL_STATUSES.has(claimed.status) && sessionPath === undefined) {
    context.store.transition(claimed.task_id, { type: "dispose", timestamp: nowIso(context) })
    return {
      task_id: claimed.task_id,
      kind: "resumed",
      reason: "terminal without transcript disposed; persisted result preserved",
    }
  }

  const rollbackResidency: SuspendedResidency = claimed.execution_mode === "process" ? "rpc_detached" : "persisted_only"
  if (context.config.reattach_on_reconcile === false) {
    rollbackClaim(context, claimed.task_id, rollbackResidency)
    return deferred(claimed.task_id, "reattach_disabled")
  }
  return reviveClaimed(context, claimed, rollbackResidency, sessionPath)
}

async function reviveClaimed(
  context: LifecycleContext,
  claimed: TaskRecord,
  rollbackResidency: SuspendedResidency,
  sessionPath: string | undefined,
): Promise<ReconcileOutcome> {
  const fresh = context.store.load(claimed.task_id)
  if (!isClaimHeld(context, fresh, claimed.parent_session_id) || fresh.killed === true || !REVIVABLE_STATUSES.has(fresh.status)) {
    rollbackClaim(context, claimed.task_id, rollbackResidency)
    return deferred(claimed.task_id, "foreign_live_owner")
  }

  if (fresh.execution_mode === "process" && fresh.pid !== undefined) {
    const terminated = await terminateOldRpc(context, fresh)
    if (!terminated) {
      rollbackClaim(context, fresh.task_id, rollbackResidency)
      return deferred(fresh.task_id, "session_unavailable")
    }
  }

  if (sessionPath === undefined && !isSpawnSpecV1Record(fresh)) {
    if (TERMINAL_STATUSES.has(fresh.status)) {
      context.store.transition(fresh.task_id, { type: "dispose", timestamp: nowIso(context) })
      return {
        task_id: fresh.task_id,
        kind: "resumed",
        reason: "terminal without transcript disposed; persisted result preserved",
      }
    }
    await markLost(context, fresh, "record has neither a session transcript nor a persisted v1 spawn spec")
    return { task_id: fresh.task_id, kind: "lost", reason: "spawn spec unavailable" }
  }

  const ports = context.reattachPorts ?? getLifecycleReattachPorts(context.store)
  if (ports === undefined) {
    await markLost(context, fresh, "reattach ports unavailable")
    return { task_id: fresh.task_id, kind: "lost", reason: "reattach ports unavailable" }
  }

  const respawned = await ports.respawn(fresh, sessionPath)
  if (!respawned.ok) {
    if (respawned.disposition === "retryable") {
      rollbackClaim(context, fresh.task_id, rollbackResidency)
      return deferred(fresh.task_id, deferredCode(respawned.code))
    }
    if (TERMINAL_STATUSES.has(fresh.status)) {
      context.store.transition(fresh.task_id, { type: "dispose", timestamp: nowIso(context) })
      return { task_id: fresh.task_id, kind: "resumed", reason: respawned.reason }
    }
    await markLost(context, fresh, `reattach failed: ${respawned.reason}`)
    return { task_id: fresh.task_id, kind: "lost", reason: respawned.reason }
  }

  const reattached = await ports.reattach(fresh, respawned.handle)
  if (!reattached.ok) {
    if (reattached.kind === "already_attached") {
      return { task_id: fresh.task_id, kind: "resumed", reason: reattached.reason }
    }
    rollbackClaim(context, fresh.task_id, rollbackResidency)
    return deferred(fresh.task_id, "session_unavailable")
  }
  context.store.appendEvent(fresh.task_id, {
    type: "reconcile_reattached",
    payload: sessionPath === undefined ? { fresh_launch: true } : { session_path: sessionPath },
  })
  return { task_id: fresh.task_id, kind: "resumed", reason: "respawned and reattached" }
}

async function terminateOldRpc(context: LifecycleContext, record: TaskRecord): Promise<boolean> {
  const pid = record.pid
  if (pid === undefined || !context.signaller.isAlive(pid)) return true
  context.signaller.signal(pid, "SIGTERM")
  context.store.appendEvent(record.task_id, { type: "reconcile_terminated", payload: { pid, signal: "SIGTERM" } })
  await delay(context.orphanKillDelayMs)
  if (context.signaller.isAlive(pid)) {
    context.signaller.signal(pid, "SIGKILL")
    context.store.appendEvent(record.task_id, { type: "reconcile_terminated", payload: { pid, signal: "SIGKILL" } })
  }
  return !context.signaller.isAlive(pid)
}

function rollbackClaim(context: LifecycleContext, taskId: string, residency: SuspendedResidency): void {
  try {
    context.store.mutate(taskId, (fresh) => {
      if (fresh.host_pid !== context.hostPid || fresh.residency_state !== "resident") return fresh
      const { host_pid: _hostPid, ...withoutHost } = fresh
      if (residency === "rpc_detached") {
        return { ...withoutHost, residency_state: residency, updated_at: nowIso(context) }
      }
      const { pid: _pid, ...withoutPid } = withoutHost
      return { ...withoutPid, residency_state: residency, updated_at: nowIso(context) }
    })
  } catch {
    // A rollback CAS that loses its lock/ownership race must not overwrite the winner.
  }
}

async function markLost(context: LifecycleContext, record: TaskRecord, message: string): Promise<void> {
  let applied = false
  context.store.mutate(record.task_id, (fresh) => {
    if (fresh.host_pid !== context.hostPid || fresh.residency_state !== "resident") return fresh
    const result = markRecordLostForReconciliation(fresh, {
      timestamp: nowIso(context),
      error_message: message,
      updateReason: fresh.status === "lost",
    })
    if (!result.applied) return fresh
    applied = true
    return result.record
  })
  if (!applied) return
  context.store.appendEvent(record.task_id, { type: "reconcile_lost", payload: { reason: message } })
  await destroyResidentTask(context, record.task_id, "reconcile_lost")
}

function disposeSuspendedTerminalWithoutTranscript(context: LifecycleContext, observed: TaskRecord): boolean {
  let applied = false
  try {
    context.store.mutate(observed.task_id, (fresh) => {
      if (!SUSPENDED_RESIDENCIES.has(fresh.residency_state) || !TERMINAL_STATUSES.has(fresh.status)) return fresh
      applied = true
      const { host_pid: _hostPid, ...rest } = fresh
      return { ...rest, residency_state: "disposed", updated_at: nowIso(context) }
    })
  } catch {
    return false
  }
  return applied
}

function suspendedCandidates(context: LifecycleContext, parentSessionId: string): readonly RevivalCandidate[] {
  return context.store.list().records.flatMap((record): readonly RevivalCandidate[] => {
    if (record.parent_session_id !== parentSessionId || !isSuspended(record)) return []
    if (!REVIVABLE_STATUSES.has(record.status) || record.killed === true) return []
    return [{ record, priorResidency: record.residency_state }]
  })
}

function isOrphan(context: LifecycleContext, record: TaskRecord): boolean {
  if (record.host_pid === context.hostPid) return !hasLiveHandle(context, record.task_id)
  return record.host_pid === undefined || !context.signaller.isAlive(record.host_pid)
}

function hasLiveHandle(context: LifecycleContext, taskId: string): boolean {
  return context.registry.get(taskId) !== undefined || context.registry.entries().some((handle) => handle.task_id === taskId)
}

function isClaimHeld(
  context: LifecycleContext,
  record: TaskRecord | null,
  parentSessionId: string,
): record is TaskRecord {
  return record !== null && record.parent_session_id === parentSessionId &&
    record.residency_state === "resident" && record.host_pid === context.hostPid
}

function isSuspended(record: TaskRecord): record is TaskRecord & { readonly residency_state: SuspendedResidency } {
  return record.residency_state === "persisted_only" || record.residency_state === "rpc_detached"
}

function isSpawnSpecV1Record(record: TaskRecord): boolean {
  return record.spawn_spec !== undefined && isSpawnSpecV1(record.spawn_spec)
}

function deferredCode(code: RespawnFailureCode): ReconcileDeferredReason {
  return code === "respawn_failed" ? "session_unavailable" : code
}

export function beginLocalReclamation(context: LifecycleContext, taskId: string): (() => void) | undefined {
  const key = `${context.store.stateDir}\u0000${taskId}`
  if (activeLocalReclamations.has(key)) return undefined
  activeLocalReclamations.add(key)
  return () => activeLocalReclamations.delete(key)
}

function deferred(taskId: string, reason: ReconcileDeferredReason): ReconcileOutcome {
  return { task_id: taskId, kind: "deferred", reason }
}
