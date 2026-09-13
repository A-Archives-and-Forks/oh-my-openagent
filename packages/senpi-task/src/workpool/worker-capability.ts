import type { TaskRecord } from "../state"
import { parseInput, WorkpoolYieldSchema } from "./schema"
import type { WorkpoolStore } from "./store"
import { WorkpoolError } from "./types"

export function createWorkpoolYieldCapability(store: WorkpoolStore, getTask: (taskId: string) => TaskRecord | undefined) {
  return (taskId: string, runEpoch: number, value: unknown): never => {
    const input = parseInput(WorkpoolYieldSchema, value)
    const pool = store.list().find(candidate => candidate.workers.some(worker => worker.task_id === taskId))
    if (pool === undefined) throw new WorkpoolError("worker_unassigned", "Worker has no pool assignment.")
    const assignments = pool.items.filter(item => item.binding?.task_id === taskId && item.binding.run_epoch === runEpoch && item.binding.generation === pool.generation)
    if (pool.status === "cancelled" || getTask(taskId)?.notification.run_epoch !== runEpoch ||
      !pool.workers.some(worker => worker.task_id === taskId && worker.run_epoch === runEpoch) ||
      assignments.length === 0 || input.results.some(result => !assignments.some(item => item.key === result.key))) {
      throw new WorkpoolError("stale_assignment", "Yield does not identify this worker's current assignment.")
    }
    // Row 11 owns durable keyed result reconciliation. Never acknowledge results before it exists.
    throw new WorkpoolError("yield_unavailable", "Keyed result reconciliation is not enabled yet.")
  }
}
