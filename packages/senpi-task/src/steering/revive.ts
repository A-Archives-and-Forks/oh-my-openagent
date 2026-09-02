import type { ManagedChildHandle } from "../manager/child-handle"
import { getLifecycleDetachedRevival } from "../lifecycle/port"
import type { TaskRecord } from "../state"
import { buildRevived, lazyRevivalFailure } from "./engine-policy"
import type { ReviveReservation, SendOutcome, SteeringPort } from "./types"

export async function reviveTerminal(
  port: SteeringPort,
  record: TaskRecord,
  handle: ManagedChildHandle,
  message: string,
  nowIso: () => string,
  beginSend: (taskId: string) => boolean,
  endSend: (taskId: string) => void,
): Promise<SendOutcome> {
  if (!beginSend(record.task_id)) return evictionRefusal(record.task_id)
  try {
    return await deliverRevivedTerminal(port, record, handle, message, nowIso)
  } finally {
    endSend(record.task_id)
  }
}

export async function reviveDetachedTerminalOnSend(
  port: SteeringPort,
  record: TaskRecord,
  message: string,
  nowIso: () => string,
  beginSend: (taskId: string) => boolean,
  endSend: (taskId: string) => void,
): Promise<SendOutcome> {
  if (!beginSend(record.task_id)) return evictionRefusal(record.task_id)
  try {
    const reviveDetached = port.reviveDetached ?? getLifecycleDetachedRevival(port.store)
    if (reviveDetached === undefined) return lazyRevivalFailure(record, "revival is unavailable")
    const revived = await reviveDetached(record.task_id)
    if (!revived.ok) return lazyRevivalFailure(record, revived.reason)
    const fresh = port.store.load(record.task_id)
    const handle = port.liveHandle(record.task_id)
    if (fresh === null || handle === undefined) return lazyRevivalFailure(record, "child handle is unavailable")
    return deliverRevivedTerminal(port, fresh, handle, message, nowIso)
  } finally {
    endSend(record.task_id)
  }
}

async function deliverRevivedTerminal(
  port: SteeringPort,
  record: TaskRecord,
  handle: ManagedChildHandle,
  message: string,
  nowIso: () => string,
): Promise<SendOutcome> {
  const reservation: ReviveReservation = port.reserveForRevive(record.task_id)
  if (!reservation.ok) {
    return { kind: "capacity_deferred", task_id: record.task_id, reason: "Task capacity is full; retry explicitly." }
  }
  try {
    await handle.followUp(message)
    const revived = buildRevived(record, nowIso())
    port.store.replace(revived)
    port.store.appendEvent(record.task_id, { type: "revived", payload: { run_epoch: revived.notification.run_epoch } })
    reservation.commit()
    return { kind: "revived", task_id: record.task_id, run_epoch: revived.notification.run_epoch }
  } catch (error) {
    reservation.release()
    throw error
  }
}

function evictionRefusal(taskId: string): SendOutcome {
  return {
    kind: "not_continuable",
    task_id: taskId,
    reason: `Task ${taskId} is being evicted; send was not started.`,
    suggestion: "Use task_output to read the final result.",
  }
}
