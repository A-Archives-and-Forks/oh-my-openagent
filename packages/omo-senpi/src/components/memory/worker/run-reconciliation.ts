import { existsSync } from "node:fs"
import { readdir } from "node:fs/promises"
import { hostname as readHostname } from "node:os"
import { join } from "node:path"

import {
  getPidLiveness,
  getProcessStartIdentity,
  type MemoryIdentity,
  type ProcessLiveness,
  type ReservedRun,
} from "@oh-my-opencode/memory-core"

import { readRunJson } from "./run-artifacts"
import {
  abandonReservationRun,
  failReservationRun,
  finalizeRecordedOutcome,
  type ReservationRunResult,
  type ReservationStatePort,
} from "./run-finalization"
import { classifyRunProcess, signalRecordedProcessGroup, waitUntil as waitForTime } from "./run-liveness"
import { parseReservationRunLedger, type ReservationRunLedger } from "./reservation-run-ledger"
import { waitForRunSentinel, type SentinelWaitResult } from "./run-sentinel"

export type ReflectionRunReconcileResult = ReservationRunResult

export interface ReflectionRunReconciliationOptions {
  readonly identity: MemoryIdentity
  readonly reservation: ReservationStatePort
  readonly launch?: (run: ReservedRun) => void
  readonly now?: () => number
  readonly hostname?: () => string
  readonly getPidLiveness?: (pid: number) => ProcessLiveness
  readonly getProcessStartIdentity?: (pid: number) => Promise<string | null>
  readonly waitForOutcome?: (path: string, deadlineAt: number) => Promise<SentinelWaitResult>
  readonly waitUntil?: (deadlineAt: number) => Promise<void>
  readonly signalProcessGroup?: (pid: number, signal: NodeJS.Signals) => void
  readonly withWriterLock?: <T>(operation: () => Promise<T>) => Promise<T>
}

type ReconcileContext = Required<Pick<ReflectionRunReconciliationOptions, "now" | "hostname">>
  & ReflectionRunReconciliationOptions

export async function reconcileReflectionRuns(
  options: ReflectionRunReconciliationOptions,
): Promise<ReflectionRunReconcileResult[]> {
  const context: ReconcileContext = {
    ...options,
    now: options.now ?? Date.now,
    hostname: options.hostname ?? readHostname,
  }
  const results: ReflectionRunReconcileResult[] = []
  const prelaunch = await reconcilePrelaunch(context)
  if (prelaunch !== undefined) results.push(prelaunch)
  const runsDir = join(options.identity.paths.reflection, "runs")
  for (const name of await directoryNames(runsDir)) {
    const runDir = join(runsDir, name)
    if (existsSync(join(runDir, "final.json")) || existsSync(join(runDir, "abandoned.json"))) continue
    if (!existsSync(join(runDir, "ledger.json"))) continue
    const ledger = parseReservationRunLedger(await readRunJson<unknown>(join(runDir, "ledger.json")))
    const result = await reconcileRun(context, runDir, ledger)
    if (result !== undefined) results.push(result)
  }
  return results
}

async function reconcilePrelaunch(context: ReconcileContext): Promise<ReflectionRunReconcileResult | undefined> {
  const active = (await context.reservation.readState()).active
  if (active?.reservedAt === undefined || active.launcherPid === undefined || active.launcherHostname === undefined) return undefined
  if (existsSync(join(context.identity.paths.reflection, "runs", active.runId))) return undefined
  if (context.now() - Date.parse(active.reservedAt) <= 60_000 || active.launcherHostname !== context.hostname()) return undefined
  const liveness = (context.getPidLiveness ?? getPidLiveness)(active.launcherPid)
  let dead = liveness === "dead"
  if (!dead && liveness === "alive" && active.launcherProcessStart !== null && active.launcherProcessStart !== undefined) {
    const actual = await (context.getProcessStartIdentity ?? getProcessStartIdentity)(active.launcherPid)
    dead = actual !== null && actual !== active.launcherProcessStart
  }
  if (!dead) return undefined
  const transition = await context.reservation.complete(active.runId, "failed")
  if (transition.launch !== undefined) context.launch?.(transition.launch)
  return { runId: active.runId, outcome: "failed" }
}

async function reconcileRun(
  context: ReconcileContext,
  runDir: string,
  ledger: ReservationRunLedger,
): Promise<ReflectionRunReconcileResult | undefined> {
  const outcomePath = join(runDir, "outcome.json")
  if (existsSync(outcomePath)) return await finalizeRecordedOutcome(context, runDir, ledger)
  const supervisor = await classifyRunProcess(ledger.pid, ledger.processStart, context)
  if (supervisor === "alive" || supervisor === "unknown") {
    const wait = context.waitForOutcome ?? ((path, deadlineAt) => waitForRunSentinel(path, deadlineAt, context.now))
    if (await wait(outcomePath, ledger.deadlineAt) === "present" || existsSync(outcomePath)) {
      return await finalizeRecordedOutcome(context, runDir, ledger)
    }
    const refreshed = parseReservationRunLedger(await readRunJson<unknown>(join(runDir, "ledger.json")))
    const freshSupervisor = await classifyRunProcess(refreshed.pid, refreshed.processStart, context)
    if (freshSupervisor === "unknown" || freshSupervisor === "absent") {
      return await abandonReservationRun(context, runDir, refreshed)
    }
    return freshSupervisor === "alive" ? undefined : await reconcileDeadSupervisor(context, runDir, refreshed)
  }
  return await reconcileDeadSupervisor(context, runDir, ledger)
}

async function reconcileDeadSupervisor(
  context: ReconcileContext,
  runDir: string,
  ledger: ReservationRunLedger,
): Promise<ReflectionRunReconcileResult | undefined> {
  let child = await classifyRunProcess(ledger.childPid, ledger.childProcessStart, context)
  if (child === "unknown") return await abandonReservationRun(context, runDir, ledger)
  if (child === "dead" || child === "absent") return await failReservationRun(context, runDir, ledger, "failed")
  const wait = context.waitUntil ?? ((deadlineAt) => waitForTime(deadlineAt, context.now))
  await wait(ledger.hardDeadlineAt)
  child = await classifyRunProcess(ledger.childPid, ledger.childProcessStart, context)
  if (child === "dead") return await failReservationRun(context, runDir, ledger, "failed")
  if (child === "unknown") return await abandonReservationRun(context, runDir, ledger)
  const signal = context.signalProcessGroup ?? signalRecordedProcessGroup
  if (ledger.childPid !== undefined) signal(ledger.childPid, "SIGTERM")
  await wait(ledger.deadlineAt)
  child = await classifyRunProcess(ledger.childPid, ledger.childProcessStart, context)
  if (child === "unknown") return await abandonReservationRun(context, runDir, ledger)
  if (child === "alive" && ledger.childPid !== undefined) {
    signal(ledger.childPid, "SIGKILL")
    child = await classifyRunProcess(ledger.childPid, ledger.childProcessStart, context)
  }
  return child === "dead" ? await failReservationRun(context, runDir, ledger, "timed_out") : undefined
}

async function directoryNames(path: string): Promise<readonly string[]> {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return []
    throw error
  }
}
