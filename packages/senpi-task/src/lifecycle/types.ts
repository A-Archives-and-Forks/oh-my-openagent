import type { AgentLimitReached } from "./errors"
import type { DestroyCause } from "./port"

export type AdmissionResult =
  | { readonly kind: "admitted" }
  | { readonly kind: "evicted"; readonly evicted_task_id: string }
  | { readonly kind: "rejected"; readonly error: AgentLimitReached }

export type ReconcileOutcomeKind = "resumed" | "lost" | "lost_and_terminated" | "foreign_live_owner"

export type ReconcileOutcome = {
  readonly task_id: string
  readonly kind: ReconcileOutcomeKind
  readonly reason?: string
}

export type ReconcileResult = {
  readonly outcomes: readonly ReconcileOutcome[]
}

export type CleanupResult = {
  readonly deleted: readonly string[]
  readonly retained: readonly string[]
}

export type SuspendInput = {
  readonly parentSessionId: string
  readonly reason: string
}

export type SuspendFailure = {
  readonly task_id: string
  readonly error: string
}

export type SuspendSummary = {
  readonly suspended_in_process: number
  readonly suspended_rpc: number
  readonly suspended_pending: number
  readonly disposed: number
  readonly failures: readonly SuspendFailure[]
}

export type TaskLifecycle = {
  destroyResidentTask(taskId: string, cause: DestroyCause): Promise<void>
  admitResident(parentSessionId: string): Promise<AdmissionResult>
  reconcileOnSessionStart(): Promise<ReconcileResult>
  cleanupExpiredRecords(): CleanupResult
  suspendOnSessionShutdown(input: SuspendInput): Promise<SuspendSummary>
}
