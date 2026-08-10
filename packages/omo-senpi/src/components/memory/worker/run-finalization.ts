import { join } from "node:path"

import {
  createLockRecord,
  finalizeReflectionWorktree,
  memoryWriterLockPath,
  withLock,
  type MemoryIdentity,
  type ReflectionOutcome,
  type ReservedRun,
} from "@oh-my-opencode/memory-core"

import { recordReflectionCompletion } from "./completion"
import { readRunJson, readRunTextTail, writeRunJsonAtomic, type RunOutcome } from "./run-artifacts"
import { worktreeFromLedger, type ReservationRunLedger } from "./reservation-run-ledger"
import type { ReflectionReservationPort } from "./runner"

export type ReservationStatePort = ReflectionReservationPort & {
  readState(): Promise<{ readonly active?: ReservedRun }>
}

export interface RunFinalizationContext {
  readonly identity: MemoryIdentity
  readonly reservation: ReservationStatePort
  readonly launch?: (run: ReservedRun) => void
  readonly now: () => number
  readonly withWriterLock?: <T>(operation: () => Promise<T>) => Promise<T>
}

export interface ReservationRunResult {
  readonly runId: string
  readonly outcome: ReflectionOutcome | "abandoned_unknown"
}

export async function finalizeRecordedOutcome(
  context: RunFinalizationContext,
  runDir: string,
  ledger: ReservationRunLedger,
): Promise<ReservationRunResult> {
  const outcome = await readRunJson<RunOutcome>(join(runDir, "outcome.json"))
  if (outcome.runId !== ledger.runId) throw new Error(`Run outcome mismatch: ${ledger.runId}`)
  const succeeded = !outcome.timedOut && outcome.childExit.code === 0 && outcome.childExit.signal === null
  if (!succeeded) {
    const detail = (await readRunTextTail(join(runDir, "child-stderr.log"), 64 * 1024)).trim() || undefined
    return await failReservationRun(context, runDir, ledger, outcome.timedOut ? "timed_out" : "failed", detail)
  }
  const finalized = await finalizeReflectionWorktree(
    worktreeFromLedger(context.identity, ledger),
    ledger.mergePolicy === "auto"
      ? {
          mode: "auto",
          summary: `${ledger.trigger} ${ledger.runId}`,
          runId: ledger.runId,
          withWriterLock: (operation) => writerLock(context, operation),
        }
      : { mode: "explicit", withWriterLock: (operation) => writerLock(context, operation) },
  )
  return await publishFinal(context, runDir, ledger, finalized.status, finalized.detail)
}

export async function failReservationRun(
  context: RunFinalizationContext,
  runDir: string,
  ledger: ReservationRunLedger,
  outcome: "failed" | "timed_out",
  detail?: string,
): Promise<ReservationRunResult> {
  const discarded = await finalizeReflectionWorktree(worktreeFromLedger(context.identity, ledger), {
    mode: "explicit",
    withWriterLock: (operation) => writerLock(context, operation),
  })
  const combinedDetail = [detail, discarded.detail].filter((value): value is string => value !== undefined && value.length > 0).join("; ")
  return await publishFinal(context, runDir, ledger, outcome, combinedDetail || undefined)
}

export async function abandonReservationRun(
  context: RunFinalizationContext,
  runDir: string,
  ledger: ReservationRunLedger,
): Promise<ReservationRunResult> {
  await completeReservation(context, ledger.runId, "failed")
  await writeRunJsonAtomic(join(runDir, "abandoned.json"), {
    version: 1,
    runId: ledger.runId,
    outcome: "abandoned_unknown",
    abandonedAt: new Date(context.now()).toISOString(),
  })
  return { runId: ledger.runId, outcome: "abandoned_unknown" }
}

async function publishFinal(
  context: RunFinalizationContext,
  runDir: string,
  ledger: ReservationRunLedger,
  outcome: ReflectionOutcome,
  detail?: string,
): Promise<ReservationRunResult> {
  const active = (await context.reservation.readState()).active
  const conversationIds = active?.runId === ledger.runId ? active.request.conversationIds : []
  await completeReservation(context, ledger.runId, outcome)
  const finishedAt = new Date(context.now()).toISOString()
  await recordReflectionCompletion(join(context.identity.paths.reflection, "completions"), {
    schemaVersion: 1,
    runId: ledger.runId,
    identity: context.identity.id,
    category: "quick",
    conversationIds,
    trigger: ledger.trigger,
    ...(ledger.trigger === "dream" ? { origin: ledger.origin } : {}),
    outcome,
    ...(detail === undefined ? {} : { detail }),
    startedAt: ledger.startedAt,
    finishedAt,
    delivery: { status: "pending" },
  })
  await writeRunJsonAtomic(join(runDir, "final.json"), { version: 1, runId: ledger.runId, outcome, finishedAt })
  return { runId: ledger.runId, outcome }
}

async function completeReservation(
  context: RunFinalizationContext,
  runId: string,
  outcome: ReflectionOutcome,
): Promise<void> {
  const transition = await context.reservation.complete(runId, outcome)
  if (transition.launch !== undefined) context.launch?.(transition.launch)
}

async function writerLock<T>(context: RunFinalizationContext, operation: () => Promise<T>): Promise<T> {
  if (context.withWriterLock !== undefined) return await context.withWriterLock(operation)
  const record = await createLockRecord("memory-write")
  return await withLock(memoryWriterLockPath(context.identity.paths.locks), record, operation, { waitTimeoutMs: 5_000 })
}
