import type { TaskRecord, TaskTransition, TaskTransitionResult } from "../state"

export type StateDirConfig = {
  readonly project_dir: string
  readonly task?: {
    readonly state_dir?: string
  }
}

export type TaskRecordDiagnostic = {
  readonly type: "parse_error"
  readonly path: string
  readonly message: string
}

export type ListTaskRecordsResult = {
  readonly records: readonly TaskRecord[]
  readonly diagnostics: readonly TaskRecordDiagnostic[]
}

export type PersistedTaskEvent = {
  readonly type: string
  readonly payload: unknown
}

export type TaskRecordStore = {
  readonly stateDir: string
  readonly save: (record: TaskRecord) => void
  // Manager-owned overwrite for bookkeeping that lives OUTSIDE the status transition table (revive
  // epoch bump, notification epoch persistence). Normal status changes must use transition().
  readonly replace: (record: TaskRecord) => void
  // Serialized read-modify-write over the freshest on-disk record. Returning the input record skips
  // the write; callers use this for narrow conditional patches that must not clobber lifecycle state.
  readonly mutate: (taskId: string, mutation: (record: TaskRecord) => TaskRecord) => TaskRecord | null
  readonly load: (taskId: string) => TaskRecord | null
  readonly list: () => ListTaskRecordsResult
  readonly appendEvent: (taskId: string, event: PersistedTaskEvent) => string
  readonly transition: (taskId: string, transition: TaskTransition) => TaskTransitionResult
  // Lifecycle-owned cleanup (TTL, cancel, reconcile): delete EVERY durable task artifact for a
  // task - children/<taskId>/ recursively, the completion spill file, the event log, and the record
  // (record-last so a crash mid-cleanup never orphans a record pointing at nothing; a later sweep
  // retries). Idempotent: a re-run on a partially-cleaned task is a no-op. Normal terminal
  // transitions must NEVER delete a record - they use transition().
  readonly remove: (taskId: string) => void
}
