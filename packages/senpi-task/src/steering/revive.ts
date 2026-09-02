import { log } from "@oh-my-opencode/utils"

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
    return await deliverRevivedTerminal(port, record, handle, message, nowIso, port.reserveForRevive(record.task_id), false)
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
    const reservation = port.reserveForDetachedRevive?.(record) ?? port.reserveForRevive(record.task_id)
    if (!reservation.ok) {
      return { kind: "capacity_deferred", task_id: record.task_id, reason: "Task capacity is full; retry explicitly." }
    }
    const reviveDetached = port.reviveDetached ?? getLifecycleDetachedRevival(port.store)
    if (reviveDetached === undefined) {
      reservation.release()
      return lazyRevivalFailure(record, "revival is unavailable")
    }
    let revived: Awaited<ReturnType<typeof reviveDetached>>
    try {
      revived = await reviveDetached(record.task_id, reservation)
    } catch (error) {
      await bestEffortRollback(port, record)
      reservation.release()
      return lazyRevivalFailure(record, error instanceof Error ? error.message : String(error))
    }
    if (!revived.ok) {
      reservation.release()
      return lazyRevivalFailure(record, revived.reason)
    }
    const fresh = port.store.load(record.task_id)
    const handle = port.liveHandle(record.task_id)
    if (fresh === null || handle === undefined) {
      await bestEffortRollback(port, record)
      reservation.release()
      return lazyRevivalFailure(record, "child handle is unavailable")
    }
    return deliverRevivedTerminal(port, fresh, handle, message, nowIso, reservation, true, record)
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
  reservation: ReviveReservation,
  rollbackOnFailure: boolean,
  priorRecord?: TaskRecord,
): Promise<SendOutcome> {
  if (!reservation.ok) {
    return { kind: "capacity_deferred", task_id: record.task_id, reason: "Task capacity is full; retry explicitly." }
  }
  try {
    const revived = buildRevived(record, nowIso())
    port.store.replace(revived)
    port.store.appendEvent(record.task_id, { type: "revived", payload: { run_epoch: revived.notification.run_epoch } })
    await handle.followUp(message)
    reservation.commit()
    return { kind: "revived", task_id: record.task_id, run_epoch: revived.notification.run_epoch }
  } catch (error) {
    if (rollbackOnFailure && priorRecord !== undefined) await bestEffortRollback(port, priorRecord)
    reservation.release()
    return lazyRevivalFailure(record, error instanceof Error ? error.message : String(error))
  }
}

async function bestEffortRollback(port: SteeringPort, priorRecord: TaskRecord): Promise<void> {
  try {
    await port.destruction.destroyResidentTask(priorRecord.task_id, "revive_failure")
  } catch (error) {
    log("senpi-task lazy revival destruction failed", {
      taskId: priorRecord.task_id,
      error: error instanceof Error ? error.message : String(error),
    })
  }
  try {
    port.store.replace({
      ...priorRecord,
      residency_state: "rpc_detached",
      updated_at: new Date(port.now()).toISOString(),
    })
  } catch (error) {
    log("senpi-task lazy revival rollback failed", {
      taskId: priorRecord.task_id,
      error: error instanceof Error ? error.message : String(error),
    })
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
