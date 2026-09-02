import type { TaskRecord } from "../state"
import { delay, nowIso, type LifecycleContext } from "./context"
import type { ReconcileOutcome } from "./types"

/** Release a terminal resident without relaunching its completed child session. */
export async function detachTerminalResident(
  context: LifecycleContext,
  record: TaskRecord,
): Promise<ReconcileOutcome> {
  if (record.execution_mode === "process" && record.pid !== undefined) {
    const terminated = await terminateClaimedPid(context, record)
    if (!terminated) {
      return {
        task_id: record.task_id,
        kind: "deferred",
        reason: "terminal resident pid could not be terminated",
      }
    }
  }

  const transition = context.store.transition(record.task_id, {
    type: record.execution_mode === "process" ? "detach_rpc" : "persist_only",
    timestamp: nowIso(context),
  })
  if (!transition.applied) {
    return { task_id: record.task_id, kind: "foreign_live_owner", reason: "terminal detach lost ownership" }
  }
  return { task_id: record.task_id, kind: "resumed", reason: "terminal resident detached" }
}

export async function terminateClaimedPid(context: LifecycleContext, record: TaskRecord): Promise<boolean> {
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
