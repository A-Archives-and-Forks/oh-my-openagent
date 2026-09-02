import type { TaskRecord } from "../state"
import { TERMINAL_STATUSES, type LifecycleContext } from "./context"
import { reviveClaimed } from "./reconcile-reclamation"
import { claimResidencySlot } from "./residency"
import { newestSessionPath } from "./session-path"
import type { DetachedRevivalResult } from "./port"

const LAZY_REVIVABLE_STATUSES = new Set(["completed", "error", "interrupted"])

/** Claim and reattach one terminal process only when task_send explicitly asks for it. */
export async function reviveDetachedTerminal(
  context: LifecycleContext,
  taskId: string,
): Promise<DetachedRevivalResult> {
  const observed = context.store.load(taskId)
  if (!isLazyRevivalCandidate(observed)) return { ok: false, reason: "task is not a detached terminal RPC child" }
  const sessionPath = newestSessionPath(context, taskId)
  if (sessionPath === undefined) return { ok: false, reason: "task transcript is unavailable" }

  const claimed = claimResidencySlot(context, taskId, (fresh) =>
    fresh.execution_mode === "process" &&
    fresh.residency_state === "rpc_detached" &&
    LAZY_REVIVABLE_STATUSES.has(fresh.status) &&
    fresh.killed !== true,
  )
  if (claimed !== "claimed") return { ok: false, reason: "task revival was claimed by another owner" }

  const fresh = context.store.load(taskId)
  if (fresh === null) return { ok: false, reason: "task disappeared during revival" }
  const outcome = await reviveClaimed(context, fresh, "rpc_detached", sessionPath, {
    allowTerminal: true,
    rollbackTerminalFailure: true,
  })
  return outcome.kind === "resumed"
    ? { ok: true }
    : { ok: false, reason: outcome.reason ?? "task revival failed" }
}

function isLazyRevivalCandidate(record: TaskRecord | null): record is TaskRecord {
  return record !== null &&
    record.execution_mode === "process" &&
    record.residency_state === "rpc_detached" &&
    LAZY_REVIVABLE_STATUSES.has(record.status) &&
    TERMINAL_STATUSES.has(record.status) &&
    record.killed !== true
}
