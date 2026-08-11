import { existsSync } from "node:fs"
import { join } from "node:path"

import {
  readRunJson,
  runOutcomeMatchesLedger,
  type RunOutcome,
} from "./run-artifacts"
import { classifyRunProcess, type RunLivenessSeams } from "./run-liveness"
import {
  parseReservationRunLedger,
  type ReservationRunLedger,
} from "./reservation-run-ledger"

interface RunPublicationPending {
  readonly version: 1
  readonly runId: string
  readonly attempt: number
  readonly finishedAt: string
}

export type RunAbandonmentPrecedence =
  | { readonly decision: "finalize"; readonly ledger: ReservationRunLedger }
  | { readonly decision: "veto"; readonly ledger: ReservationRunLedger }
  | { readonly decision: "abandon"; readonly ledger: ReservationRunLedger }

export async function checkRunAbandonmentPrecedence(
  runDir: string,
  runId: string,
  seams: RunLivenessSeams,
): Promise<RunAbandonmentPrecedence> {
  const ledger = parseReservationRunLedger(await readRunJson<unknown>(join(runDir, "ledger.json")))
  if (ledger.runId !== runId) throw new Error(`Finalization ledger mismatch: ${runId}`)

  const outcomePath = join(runDir, "outcome.json")
  if (existsSync(outcomePath)) {
    const outcome = await readRunJson<RunOutcome>(outcomePath)
    if (runOutcomeMatchesLedger(ledger, outcome)) return { decision: "finalize", ledger }
  }

  const publishingPath = join(runDir, "publishing.json")
  if (existsSync(publishingPath)) {
    const publishing = await readRunJson<RunPublicationPending>(publishingPath)
    if (publishing.version === 1
      && publishing.runId === ledger.runId
      && publishing.attempt === ledger.attempt) {
      return { decision: "veto", ledger }
    }
  }

  const [supervisor, child] = await Promise.all([
    classifyRunProcess(ledger.pid, ledger.processStart, seams),
    classifyRunProcess(ledger.childPid, ledger.childProcessStart, seams),
  ])
  return supervisor === "alive" || child === "alive"
    ? { decision: "veto", ledger }
    : { decision: "abandon", ledger }
}
