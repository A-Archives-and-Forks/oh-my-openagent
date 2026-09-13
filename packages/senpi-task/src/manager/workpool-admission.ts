import type { ToolDefinition } from "@code-yeongyu/senpi"
import { interactionPolicyForAgent } from "../agents/interaction-policy"
import { acquireSessionAdmissionLease } from "../lifecycle/admission-lease"
import { createTaskId } from "../state/id"
import { messageability, type TaskRecord } from "../state"
import { oneShotPolicyDenial } from "../steering/engine-policy"
import type { ReviveReservation, SendOutcome } from "../steering/types"
import { WorkpoolError, type WorkpoolAgent, type WorkpoolCaller, type WorkpoolSpec } from "../workpool/types"
import type { WorkpoolAdmission, WorkpoolRequest } from "../workpool/ports"
import { TaskConcurrency } from "./concurrency"
import { decideDepthPolicy } from "./depth-policy"
import { resolveExecutionMode } from "./execution-mode"
import { prepareWorkpoolLaunch, type WorkpoolLaunch } from "./workpool-start"
import { workpoolProcessLaunch } from "./workpool-process-launch"
import type { TaskManagerOptions } from "./types"

export type PoolManagerPorts = {
  readonly options: TaskManagerOptions
  readonly concurrency: TaskConcurrency
  readonly hostPid: number
  readonly get: WorkpoolAdmission["get"]
  readonly pending: WorkpoolAdmission["pending"]
  readonly cancel: WorkpoolAdmission["cancel"]
  readonly waitFor: WorkpoolAdmission["waitFor"]
  launch(context: WorkpoolLaunch): Promise<{ ok: true } | { ok: false; error: string }>
  revive(record: TaskRecord, message: string, reservation: ReviveReservation): Promise<SendOutcome>
  trackRevive(taskId: string, epoch: number): void
  nextSequence(parentSessionId: string): number
  workerTools(taskId: string): readonly ToolDefinition[]
}

export function createWorkpoolAdmission(ports: PoolManagerPorts): WorkpoolAdmission {
  const { options, concurrency } = ports
  function resolve(caller: WorkpoolCaller, agent: WorkpoolAgent): WorkpoolSpec {
    const start = {
      ...agent, parent_session_id: caller.sessionId, root_session_id: caller.rootSessionId,
      depth: caller.depth + 1, cwd: caller.cwd,
    }
    const result = options.planner(start)
    if (result.kind === "error") throw new WorkpoolError("policy_denied", result.error.message)
    const plan = result.plan
    const decision = decideDepthPolicy({ childDepth: start.depth, maxDepth: plan.maxDepth ?? options.config.max_depth,
      targetAgentType: agent.subagent_type ?? plan.agentType, allowedSubagents: plan.allowedSubagents ?? [] })
    if (!decision.allowed) throw new WorkpoolError("policy_denied", decision.reason)
    const executionMode = resolveExecutionMode({ agentMode: plan.agentExecutionMode, configMode: options.config.default_execution_mode })
    return { start: { ...start, execution_mode: executionMode }, plan }
  }

  function request(input: WorkpoolRequest): { cancel(): void } {
    const { pool, item, worker } = input
    const taskId = worker?.task_id ?? createTaskId()
    const epoch = worker === undefined ? 0 : worker.run_epoch + 1
    const model = pool.worker_spec.plan.model
    let cancelled = false
    let granted = false
    let transferred = false
    const release = (): void => concurrency.releaseLease(taskId, epoch)
    const current = (): boolean => !cancelled && input.current()
    const event = (kind: "granted" | "dispatched"): void => input.event({ kind, pool_id: pool.pool_id, item_id: item.item_id, task_id: taskId, run_epoch: epoch })

    async function launch(): Promise<void> {
      try {
        if (!current()) return
        event("granted")
        input.authorize()
        const message = JSON.stringify({ pool_id: pool.pool_id, generation: pool.generation, items: [{ item_id: item.item_id, key: item.key, input: item.input }] })
        if (worker !== undefined) {
          const record = ports.get(taskId)
          if (record === undefined || record.parent_session_id !== pool.parent_session_id || record.notification.run_epoch !== worker.run_epoch ||
            messageability(record.status, record.residency_state, record.execution_mode, record.killed) !== "revive" ||
            oneShotPolicyDenial(record) !== undefined || ports.pending(taskId)) {
            throw new WorkpoolError("worker_not_continuable", "Worker is no longer eligible for reuse.")
          }
          if (!input.bind(taskId, epoch)) return
          const result = await ports.revive(record, message, { ok: true, release, commit: () => ports.trackRevive(taskId, epoch) })
          if (result.kind !== "revived") throw new WorkpoolError("worker_not_continuable", "Worker did not acknowledge the admitted turn.")
          transferred = true
        } else {
          const acquired = await acquireSessionAdmissionLease(options.store.stateDir, pool.parent_session_id)
          if (acquired.kind !== "acquired") throw new WorkpoolError("admission_refused", "Residency admission is contended.")
          let context: WorkpoolLaunch
          try {
            if (!current()) return
            const admission = await options.admit?.(pool.parent_session_id)
            if (admission?.kind === "rejected") throw new WorkpoolError("admission_refused", admission.message)
            if (!current()) return
            input.authorize()
            if (!acquired.lease.isOwner()) throw new WorkpoolError("admission_refused", "Residency admission lease was displaced.")
            if (!input.bind(taskId, epoch)) return
            context = prepareWorkpoolLaunch({ options, workerSpec: pool.worker_spec, taskId, hostPid: ports.hostPid,
              taskSeq: ports.nextSequence(pool.parent_session_id),
              spec: { ...pool.worker_spec.start,
                prompt: interactionPolicyForAgent(pool.worker_spec.start.subagent_type ?? "")?.promptContract === "plan-review"
                  ? pool.worker_spec.start.prompt : `${pool.worker_spec.start.prompt}\n\n${message}`,
                memberScopedTools: ports.workerTools(taskId),
                ...(pool.worker_spec.start.execution_mode === "process" ? workpoolProcessLaunch(options.store.stateDir, taskId) : {}),
              },
            })
          } finally { acquired.lease.release() }
          if (!current()) { await ports.cancel(taskId); return }
          const result = await ports.launch(context)
          if (!result.ok) throw new WorkpoolError("spawn_failed", result.error)
          transferred = true
        }
        event("dispatched")
      } catch (error) {
        const failure = error instanceof WorkpoolError ? error : new WorkpoolError("spawn_failed", "Worker admission failed.")
        input.event({ kind: "admission_failed", pool_id: pool.pool_id, item_id: item.item_id, task_id: taskId, run_epoch: epoch,
          error: { code: failure.code, message: failure.message } })
      } finally { if (!transferred) release() }
    }
    concurrency.enqueue(model, taskId, epoch, () => { granted = true; void launch() })
    return { cancel: () => {
      cancelled = true
      concurrency.remove(model, taskId)
      // A grant inside an async residency gate owns its lease until that gate unwinds.
      if (!granted) release()
    } }
  }
  return { resolve, request, hasFreeSlot: model => concurrency.hasFreeSlot(model), drain: () => concurrency.drain(),
    get: ports.get, pending: ports.pending, cancel: ports.cancel, waitFor: ports.waitFor }
}
