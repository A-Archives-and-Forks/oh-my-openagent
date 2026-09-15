import type { Json, PoolId, WorkpoolRecord } from "./types"

export type WorkpoolAggregateResult =
  | { readonly key: string; readonly data: Json }
  | { readonly key: string; readonly error: { readonly code: string; readonly message: string } }
export type WorkpoolAggregateMessage = {
  readonly pool_id: PoolId
  readonly generation: number
  readonly results: readonly WorkpoolAggregateResult[]
}
export type WorkpoolAggregatePort = {
  enqueue(message: WorkpoolAggregateMessage): void
}

const terminal = new Set(["completed", "error", "cancelled"])

export function aggregateResults(pool: WorkpoolRecord): readonly WorkpoolAggregateResult[] | undefined {
  if (pool.status !== "closing" && pool.status !== "cancelled") return undefined
  if (pool.aggregate?.delivered === true && pool.aggregate.generation === pool.generation) return undefined
  if (pool.items.some(item => !terminal.has(item.status))) return undefined
  return pool.items.map(item => item.status === "completed"
    ? { key: item.key, data: item.data ?? null }
    : { key: item.key, error: item.error ?? { code: "cancelled", message: "Pool item did not complete." } })
}

export function deliverAggregate(
  pool: WorkpoolRecord,
  port: WorkpoolAggregatePort | undefined,
  persist: (delivered: boolean) => void,
): boolean {
  const results = aggregateResults(pool)
  if (results === undefined || port === undefined) return false
  try {
    port.enqueue({ pool_id: pool.pool_id, generation: pool.generation, results })
    persist(true)
    return true
  } catch {
    persist(false)
    return false
  }
}
