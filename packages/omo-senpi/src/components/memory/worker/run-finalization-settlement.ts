import { join } from "node:path"

import { ensureReflectionCompletion } from "./completion"
import {
  readRunJson,
  updateRunLedger,
  writeRunJsonAtomic,
} from "./run-artifacts"
import type {
  DurableFinalizationDecision,
  ReservationRunResult,
  RunFinalizationContext,
} from "./run-finalization-types"
import {
  parseReservationRunLedger,
  type ReservationRunLedger,
} from "./reservation-run-ledger"

export async function settleReservationRun(
  context: RunFinalizationContext,
  runDir: string,
  inputLedger: ReservationRunLedger,
  decision: DurableFinalizationDecision,
): Promise<ReservationRunResult> {
  const ledgerPath = join(runDir, "ledger.json")
  const current = parseReservationRunLedger(await readRunJson<unknown>(ledgerPath))
  if (current.runId !== inputLedger.runId) throw new Error("Finalization ledger run id changed")
  const finalizedAt = current.finalizedAt ?? new Date(context.now()).toISOString()
  await updateRunLedger(ledgerPath, {
    finalizeOutcome: decision.outcome,
    ...(decision.reason === undefined ? {} : { finalizeReason: decision.reason }),
    ...(decision.detail === undefined ? {} : { finalizeDetail: decision.detail }),
    ...(decision.integrationSha === undefined ? {} : { integrationSha: decision.integrationSha }),
    finalizedAt,
  })

  const active = (await context.reservation.readState()).active
  const conversationIds = current.conversationIds
    ?? (active?.runId === current.runId ? active.request.conversationIds : [])
  let launch
  if (active?.runId === current.runId) {
    const transition = await context.reservation.complete(current.runId, decision.outcome)
    if (transition.launch !== undefined) context.launch?.(transition.launch)
    launch = transition.launch
  }

  const completion = await ensureReflectionCompletion(join(context.identity.paths.reflection, "completions"), {
    schemaVersion: 1,
    runId: current.runId,
    identity: context.identity.id,
    category: current.category ?? "quick",
    ...(current.model === undefined ? {} : { model: current.model }),
    ...(current.thinking === undefined ? {} : { thinking: current.thinking }),
    conversationIds,
    trigger: current.trigger,
    ...(current.origin === undefined ? {} : { origin: current.origin }),
    outcome: decision.outcome,
    ...(decision.reason === undefined ? {} : { reason: decision.reason }),
    ...(decision.detail === undefined ? {} : { detail: decision.detail }),
    startedAt: current.startedAt,
    finishedAt: finalizedAt,
    delivery: { status: "pending" },
  })
  await updateRunLedger(ledgerPath, { finalizePhase: "settled" })
  await writeRunJsonAtomic(join(runDir, "final.json"), {
    version: 1,
    runId: current.runId,
    outcome: decision.outcome,
    finishedAt: finalizedAt,
    ...(decision.integrationSha === undefined ? {} : { integrationSha: decision.integrationSha }),
  })
  return {
    runId: current.runId,
    outcome: decision.outcome,
    ...(decision.reason === undefined ? {} : { reason: decision.reason }),
    ...(decision.detail === undefined ? {} : { detail: decision.detail }),
    completion,
    ...(launch === undefined ? {} : { launch }),
  }
}
