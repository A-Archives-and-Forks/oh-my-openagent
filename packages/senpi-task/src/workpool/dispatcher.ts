import type { WorkpoolAdmission } from "./ports"
import type { WorkpoolStore } from "./store"
import { WorkpoolError, type PoolId, type WorkpoolEvent, type WorkpoolRecord, type WorkpoolWorker } from "./types"

export function orderIdleWorkers(workers: readonly WorkpoolWorker[]): readonly WorkpoolWorker[] {
  return workers.filter(worker => worker.status === "idle").toSorted((a, b) =>
    a.completed_turns - b.completed_turns || a.idle_since - b.idle_since || (a.task_id < b.task_id ? -1 : a.task_id > b.task_id ? 1 : 0))
}

export function createWorkpoolDispatcher(ports: {
  readonly store: WorkpoolStore; readonly admission: WorkpoolAdmission
  emit(event: WorkpoolEvent): void; authorize(pool: WorkpoolRecord): void
}) {
  const { store, admission, emit } = ports
  const scheduled = new Map<PoolId, ReturnType<typeof setImmediate>>()
  const pending = new Map<string, { readonly poolId: PoolId; readonly workerId?: string; cancel(): void }>()
  const completions = new Map<string, AbortController>()
  let disposed = false

  function schedule(poolId: PoolId): void {
    if (disposed || scheduled.has(poolId)) return
    // Not a delay or polling loop: hand admission to the next event-loop turn, after the host
    // has returned the durable receipt. Every later wake is a push, grant or terminal event.
    scheduled.set(poolId, setImmediate(() => {
      scheduled.delete(poolId)
      try { pump(poolId) } catch (error) {
        emit({ kind: "admission_failed", pool_id: poolId, error: {
          code: error instanceof WorkpoolError ? error.code : "store_corrupt",
          message: error instanceof Error ? error.message : "Pool admission failed.",
        } })
      }
    }))
  }
  function pump(poolId: PoolId): void {
    const pool = store.load(poolId)
    if (pool.status !== "open" && pool.status !== "closing") return
    const reservedWorkers = new Set([...pending.values()].flatMap(value => value.workerId === undefined ? [] : [value.workerId]))
    for (const item of pool.items) {
      if (item.status !== "queued" || pending.has(item.item_id)) continue
      const fresh = store.load(poolId)
      const idle = pool.mode === "keep_alive" ? orderIdleWorkers(fresh.workers).find(worker => !reservedWorkers.has(worker.task_id)) : undefined
      if (pool.mode === "keep_alive" && idle === undefined &&
        (fresh.workers.length > 0 || [...pending.values()].some(value => value.poolId === poolId)) &&
        !admission.hasFreeSlot(pool.worker_spec.plan.model)) break
      if (idle !== undefined) reservedWorkers.add(idle.task_id)
      const current = (): boolean => {
        const latest = store.load(poolId)
        return !disposed && latest.generation === pool.generation && (latest.status === "open" || latest.status === "closing") &&
          latest.items.some(candidate => candidate.item_id === item.item_id && (candidate.status === "queued" || candidate.status === "assigned"))
      }
      const request = admission.request({ pool, item, ...(idle === undefined ? {} : { worker: idle }), current,
        authorize: () => ports.authorize(store.load(poolId)),
        bind: (taskId, epoch) => {
          let bound = false
          store.mutate(poolId, latest => {
            if (!current() || !latest.items.some(candidate => candidate.item_id === item.item_id && candidate.status === "queued")) return latest
            bound = true
            const prior = latest.workers.find(worker => worker.task_id === taskId)
            const worker: WorkpoolWorker = { task_id: taskId, run_epoch: epoch, status: "busy", completed_turns: prior?.completed_turns ?? 0, idle_since: prior?.idle_since ?? 0 }
            return { ...latest,
              items: latest.items.map(candidate => candidate.item_id === item.item_id ? { ...candidate, status: "assigned", binding: { task_id: taskId, run_epoch: epoch, generation: pool.generation } } : candidate),
              workers: [...latest.workers.filter(candidate => candidate.task_id !== taskId), worker],
            }
          })
          return bound
        },
        event: event => {
          if (event.kind === "admission_failed") {
            pending.delete(item.item_id)
            store.mutate(poolId, latest => ({ ...latest, items: latest.items.map(candidate =>
              candidate.item_id === item.item_id && candidate.status !== "cancelled" ? { ...candidate, status: "error", error: event.error } : candidate),
              workers: latest.workers.filter(worker => worker.task_id !== event.task_id || admission.get(worker.task_id)?.status === "running"),
            }))
            schedule(poolId)
          }
          if (event.kind === "dispatched" && event.task_id !== undefined && event.run_epoch !== undefined) {
            pending.delete(item.item_id)
            observeCompletion(pool, event.task_id, event.run_epoch)
            schedule(poolId)
          }
          emit(event)
        },
      })
      pending.set(item.item_id, { poolId, workerId: idle?.task_id, cancel: request.cancel })
      emit({ kind: "waiting", pool_id: poolId, item_id: item.item_id })
      admission.drain()
    }
  }
  function observeCompletion(pool: WorkpoolRecord, taskId: string, epoch: number): void {
    const controller = new AbortController()
    completions.set(taskId, controller)
    void admission.waitFor(taskId, controller.signal).then(record => {
      completions.delete(taskId)
      if (disposed || record.notification.run_epoch !== epoch) return
      store.mutate(pool.pool_id, latest => {
        if (latest.generation !== pool.generation) return latest
        return { ...latest, workers: latest.workers.map(worker => worker.task_id === taskId && worker.run_epoch === epoch
          ? { ...worker, status: "idle", completed_turns: worker.completed_turns + 1, idle_since: Date.now() } : worker) }
      })
      emit({ kind: "worker_idle", pool_id: pool.pool_id, task_id: taskId, run_epoch: epoch })
      schedule(pool.pool_id)
    }).catch((error: unknown) => {
      completions.delete(taskId)
      if (controller.signal.aborted) return
      emit({ kind: "admission_failed", pool_id: pool.pool_id, task_id: taskId, run_epoch: epoch,
        error: { code: "spawn_failed", message: error instanceof Error ? error.message : "Worker observation failed." } })
    })
  }
  function cancel(poolId: PoolId): void {
    const immediate = scheduled.get(poolId)
    if (immediate !== undefined) clearImmediate(immediate)
    scheduled.delete(poolId)
    for (const [id, request] of pending) {
      if (request.poolId !== poolId) continue
      request.cancel()
      pending.delete(id)
    }
  }
  // Stop scheduling and detach observers only. Child handles remain manager/lifecycle-owned.
  function stopScheduling(): void {
    disposed = true
    for (const immediate of scheduled.values()) clearImmediate(immediate)
    scheduled.clear()
    for (const request of pending.values()) request.cancel()
    pending.clear()
    for (const controller of completions.values()) controller.abort()
    completions.clear()
  }
  return { schedule, cancel, stopScheduling }
}
