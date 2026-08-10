import { createHash, randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, readdir, rm } from "node:fs/promises"
import { basename, join } from "node:path"

import {
  FactsQueue,
  GitMemoryRepo,
  LockContentionError,
  applyFactsBatch,
  buildDefaultSeedFiles,
  createLockRecord,
  getPidLiveness,
  getProcessStartIdentity,
  memoryWriterLockPath,
  parseFactsExtractionJsonl,
  restoreFactsBatch,
  withLock,
  type ApplyFactsBatchResult,
  type FactsPayload,
  type FactsPeopleRouting,
  type FactsQueueEntry,
  type MemoryIdentity,
} from "@oh-my-opencode/memory-core"
import type { SenpiModelPort, SenpiModelRegistryPort } from "@oh-my-opencode/senpi-task"

import type { ComponentLogger } from "../../extension/types"
import type { SenpiOmoConfigResult } from "../config-resolution"
import { readFactsPeoplePayload } from "./facts-people-payload"
import { resolveReflectionModel } from "./worker/resolve-model"
import {
  prepareFactsSpawn,
  runFactsChild,
  type FactsSandbox,
  type FactsRunLedgerEnvelope,
} from "./worker/spawn"
import { readRunJson, updateRunLedger, writeRunJsonAtomic, type RunOutcome } from "./worker/run-artifacts"

const QUICK_CATEGORY = "quick"
const DEFAULT_DEADLINE_MS = 15 * 60_000
const DEFAULT_GRACE_MS = 5_000
const WRITER_WAIT_MS = 2_000
const WRITER_ATTEMPTS = 3

interface FactsRunLedger extends FactsRunLedgerEnvelope {
  readonly pid?: number
  readonly processStart?: string | null
  readonly childPid?: number
  readonly childProcessStart?: string | null
}

interface FactsFinalRecord {
  readonly version: 1
  readonly runId: string
  readonly outcome: "committed" | "no_facts" | "failed"
  readonly sha?: string
}

export type FactsLaunchResult =
  | { readonly status: "empty" | "active" | "skipped" }
  | { readonly status: "committed"; readonly runId: string; readonly sha: string }
  | { readonly status: "no_facts" | "failed"; readonly runId: string }

export interface FactsExtractorRunnerOptions {
  readonly identity: MemoryIdentity
  readonly queue?: FactsQueue
  readonly cwd: string
  readonly loadConfig: () => SenpiOmoConfigResult
  readonly resolveModelRegistry: () => SenpiModelRegistryPort<SenpiModelPort> | undefined
  readonly logger?: ComponentLogger
  readonly env?: NodeJS.ProcessEnv
  readonly deadlineMs?: number
  readonly terminationGraceMs?: number
  readonly maxOutputBytes?: number
  readonly senpiCommand?: string
  readonly supervisorPath?: string
  readonly sandbox?: FactsSandbox
  readonly now?: () => Date
  readonly createBatchId?: () => string
  readonly withWriterLock?: <T>(operation: () => Promise<T>, attempt: number) => Promise<T>
  readonly retryDelay?: (attempt: number, delayMs: number) => Promise<void>
  readonly random?: () => number
}

export class FactsExtractorRunner {
  private readonly queue: FactsQueue
  private readonly now: () => Date
  private activeLaunch: Promise<FactsLaunchResult> | undefined

  constructor(private readonly options: FactsExtractorRunnerOptions) {
    this.queue = options.queue ?? new FactsQueue({ identityPaths: options.identity.paths })
    this.now = options.now ?? (() => new Date())
  }

  async launchPending(): Promise<FactsLaunchResult> {
    if (this.activeLaunch !== undefined) return { status: "active" }
    const operation = this.launchPendingOnce()
    this.activeLaunch = operation
    try {
      return await operation
    } finally {
      if (this.activeLaunch === operation) this.activeLaunch = undefined
    }
  }

  async reconcilePending(): Promise<FactsLaunchResult> {
    const active = await this.reconcileRuns()
    if (active) return { status: "active" }
    return this.launchPending()
  }

  private async launchPendingOnce(): Promise<FactsLaunchResult> {
    if (await this.reconcileRuns()) return { status: "active" }
    const entries = await this.queue.listPending()
    if (entries.length === 0) return { status: "empty" }
    const loaded = this.options.loadConfig()
    const resolution = resolveReflectionModel(QUICK_CATEGORY, loaded.config, this.options.resolveModelRegistry())
    if (resolution.kind === "category_unavailable") {
      this.options.logger?.warn("facts extractor quick category unavailable", { cause: resolution.cause })
      return { status: "skipped" }
    }

    const repo = new GitMemoryRepo({ dir: this.options.identity.paths.repo, agentId: this.options.identity.id })
    if (!existsSync(join(repo.dir, ".git"))) await repo.init({ seedFiles: buildDefaultSeedFiles() })
    const batchId = (this.options.createBatchId ?? randomUUID)()
    const launchedAt = this.now().getTime()
    const runDir = await this.reserveRunDir(entries, batchId, launchedAt)
    if (runDir === undefined) return { status: "active" }
    const runId = basename(runDir)
    const people = await readFactsPeoplePayload(repo.dir)
    const payload: FactsPayload = {
      version: 1,
      identity: this.options.identity.id,
      today: this.now().toISOString().slice(0, 10),
      entries,
      ...people,
    }
    const spawnArgs = await prepareFactsSpawn({
      runId,
      runDir,
      payload,
      model: resolution.model,
      thinking: resolution.thinking,
      env: this.options.env ?? process.env,
      senpiCommand: this.options.senpiCommand,
    })

    try {
      const child = await runFactsChild(spawnArgs, {
        deadlineMs: this.options.deadlineMs ?? DEFAULT_DEADLINE_MS,
        terminationGraceMs: this.options.terminationGraceMs,
        maxOutputBytes: this.options.maxOutputBytes,
        sandbox: this.options.sandbox,
        supervisorPath: this.options.supervisorPath,
        batchId,
        queued: queueKeys(entries),
        now: () => launchedAt,
      })
      if (child.timedOut || child.code !== 0) {
        await this.writeFinal(runDir, runId, "failed", child.stderr.trim() || "facts child failed")
        return { status: "failed", runId }
      }
    } catch (error) {
      await this.writeFinal(runDir, runId, "failed", describe(error))
      return { status: "failed", runId }
    }
    return this.finalizeRun(runDir, repo)
  }

  private async reconcileRuns(): Promise<boolean> {
    const runsDir = join(this.options.identity.paths.facts, "runs")
    const names = await readdir(runsDir).catch(() => [])
    let active = false
    for (const name of names.sort()) {
      const runDir = join(runsDir, name)
      if (existsSync(join(runDir, "final.json")) || existsSync(join(runDir, "abandoned.json"))) continue
      const ledger = await readRunJson<FactsRunLedger>(join(runDir, "ledger.json")).catch(() => undefined)
      if (ledger === undefined) continue
      if (existsSync(join(runDir, "outcome.json"))) {
        const repo = new GitMemoryRepo({ dir: this.options.identity.paths.repo, agentId: this.options.identity.id })
        try {
          await this.finalizeRun(runDir, repo)
        } catch (error) {
          this.options.logger?.warn("facts run reconciliation remains pending", {
            runId: ledger.runId,
            error: describe(error),
          })
          active = true
        }
        continue
      }
      const verdict = await runLiveness(ledger)
      if (verdict === "alive" || this.now().getTime() <= ledger.deadlineAt) {
        active = true
        continue
      }
      if (verdict === "unknown") {
        await writeRunJsonAtomic(join(runDir, "abandoned.json"), {
          version: 1, runId: ledger.runId, abandonedAt: this.now().toISOString(), reason: "unknown_liveness",
        })
      } else {
        await this.writeFinal(runDir, ledger.runId, "failed", "facts supervisor and child are not alive")
      }
    }
    return active
  }

  private async finalizeRun(runDir: string, repo: GitMemoryRepo): Promise<FactsLaunchResult> {
    const ledger = await readRunJson<FactsRunLedger>(join(runDir, "ledger.json"))
    const record = await createLockRecord("facts-finalize", { runId: ledger.runId })
    return withLock(join(this.options.identity.paths.locks, `finalize-${ledger.runId}.lock`), record, async () => {
      const finalPath = join(runDir, "final.json")
      if (existsSync(finalPath)) return finalResult(await readRunJson<FactsFinalRecord>(finalPath))
      if (existsSync(join(runDir, "abandoned.json"))) return { status: "failed", runId: ledger.runId }
      return this.finalizeClaimed(runDir, repo, ledger)
    }, { waitTimeoutMs: WRITER_WAIT_MS })
  }

  private async finalizeClaimed(
    runDir: string,
    repo: GitMemoryRepo,
    ledger: FactsRunLedger,
  ): Promise<FactsLaunchResult> {
    const payload = await readRunJson<FactsPayload>(join(runDir, "facts-payload.json"))
    const outcome = await readRunJson<RunOutcome>(join(runDir, "outcome.json"))
    if (outcome.timedOut || outcome.childExit.code !== 0) {
      await this.writeFinal(runDir, ledger.runId, "failed", "facts child did not exit successfully")
      return { status: "failed", runId: ledger.runId }
    }
    let records: ReturnType<typeof parseFactsExtractionJsonl>
    try {
      records = parseFactsExtractionJsonl(await readFile(join(runDir, "extraction.jsonl"), "utf8"))
    } catch (error) {
      await this.writeFinal(runDir, ledger.runId, "failed", describe(error))
      return { status: "failed", runId: ledger.runId }
    }

    if (ledger.headBeforeApply !== undefined) {
      const commits = await repo.log({ range: `${ledger.headBeforeApply}..HEAD` })
      const receipt = commits.find((commit) => commit.trailers["Omo-Facts-Batch"] === ledger.batchId)
      if (receipt !== undefined) {
        await this.queue.markConsumed(payload.entries)
        await this.writeFinal(runDir, ledger.runId, "committed", undefined, receipt.sha)
        return { status: "committed", runId: ledger.runId, sha: receipt.sha }
      }
    }
    if (records.length === 0) {
      await this.queue.markConsumed(payload.entries)
      await this.writeFinal(runDir, ledger.runId, "no_facts")
      return { status: "no_facts", runId: ledger.runId }
    }

    let applied: Extract<ApplyFactsBatchResult, { readonly outcome: "committed" }> | undefined
    try {
      applied = await this.applyWithRetries(runDir, ledger, repo, records)
    } catch (error) {
      await this.writeFinal(runDir, ledger.runId, "failed", describe(error))
      return { status: "failed", runId: ledger.runId }
    }
    if (applied === undefined) {
      await this.writeFinal(runDir, ledger.runId, "failed", "memory-write lock exhausted")
      return { status: "failed", runId: ledger.runId }
    }
    await this.queue.markConsumed(payload.entries)
    await this.writeFinal(runDir, ledger.runId, "committed", undefined, applied.sha)
    return { status: "committed", runId: ledger.runId, sha: applied.sha }
  }

  private async applyWithRetries(
    runDir: string,
    ledger: FactsRunLedger,
    repo: GitMemoryRepo,
    records: ReturnType<typeof parseFactsExtractionJsonl>,
  ): Promise<Extract<ApplyFactsBatchResult, { readonly outcome: "committed" }> | undefined> {
    const people = this.resolvePeopleRouting()
    for (let attempt = 1; attempt <= WRITER_ATTEMPTS; attempt += 1) {
      try {
        const result = await this.withWriterLock(async () => {
          const headBeforeApply = await repo.head()
          if (headBeforeApply === null) throw new Error("facts repository has no HEAD")
          await updateRunLedger(join(runDir, "ledger.json"), { headBeforeApply })
          await restoreFactsBatch(repo, records, { people })
          return applyFactsBatch(repo, { batchId: ledger.batchId, records }, {
            agentId: this.options.identity.id,
            authorName: "Facts Extractor",
          }, {
            people,
            onAliasTie: (tie) => this.options.logger?.warn(
              "facts person alias tie resolved by slug order",
              { alias: tie.alias, slugs: tie.slugs.join(","), chosen: tie.chosen },
            ),
          })
        }, attempt)
        if (result.outcome !== "committed") throw new Error("facts batch unexpectedly produced no commit")
        return result
      } catch (error) {
        if (!(error instanceof LockContentionError)) throw error
        if (attempt === WRITER_ATTEMPTS) {
          this.options.logger?.warn("facts extractor memory-write lock exhausted", { runId: ledger.runId })
          return undefined
        }
        const jitter = 25 + Math.floor((this.options.random ?? Math.random)() * 76)
        await (this.options.retryDelay ?? delay)(attempt, jitter)
      }
    }
    return undefined
  }

  private resolvePeopleRouting(): FactsPeopleRouting {
    const memory = this.options.loadConfig().config.memory
    const override = memory?.agents[this.options.identity.id]?.people
    return {
      enabled: override?.enabled ?? memory?.people.enabled ?? true,
      maxEntries: override?.max_entries ?? memory?.people.max_entries ?? 40,
      maxEntryChars: override?.max_entry_chars ?? memory?.people.max_entry_chars ?? 200,
    }
  }

  private async withWriterLock<T>(operation: () => Promise<T>, attempt: number): Promise<T> {
    if (this.options.withWriterLock !== undefined) return this.options.withWriterLock(operation, attempt)
    const record = await createLockRecord("memory-write", { runId: `facts-${attempt}` })
    return withLock(memoryWriterLockPath(this.options.identity.paths.locks), record, operation, {
      waitTimeoutMs: WRITER_WAIT_MS,
    })
  }

  private async reserveRunDir(
    entries: readonly FactsQueueEntry[],
    batchId: string,
    launchedAt: number,
  ): Promise<string | undefined> {
    const runsDir = join(this.options.identity.paths.facts, "runs")
    await mkdir(runsDir, { recursive: true, mode: 0o700 })
    const digest = createHash("sha256").update(JSON.stringify(queueKeys(entries))).digest("hex").slice(0, 12)
    for (let attempt = 1; attempt < 10_000; attempt += 1) {
      const runDir = join(runsDir, `facts-${digest}-${attempt}`)
      try {
        await mkdir(runDir, { mode: 0o700 })
        const deadlineMs = this.options.deadlineMs ?? DEFAULT_DEADLINE_MS
        const terminationGraceMs = this.options.terminationGraceMs ?? DEFAULT_GRACE_MS
        try {
          await writeRunJsonAtomic(join(runDir, "ledger.json"), {
            version: 1,
            runId: basename(runDir),
            kind: "facts",
            startedAt: new Date(launchedAt).toISOString(),
            hardDeadlineAt: launchedAt + deadlineMs,
            terminationGraceMs,
            deadlineAt: launchedAt + deadlineMs + terminationGraceMs,
            batchId,
            queued: queueKeys(entries),
          } satisfies FactsRunLedgerEnvelope)
        } catch (error) {
          await rm(runDir, { recursive: true, force: true })
          throw error
        }
        return runDir
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error
        if (!existsSync(join(runDir, "final.json")) && !existsSync(join(runDir, "abandoned.json"))) return undefined
      }
    }
    throw new Error("facts run sequence exhausted")
  }

  private async writeFinal(
    runDir: string,
    runId: string,
    outcome: "committed" | "no_facts" | "failed",
    detail?: string,
    sha?: string,
  ): Promise<void> {
    await writeRunJsonAtomic(join(runDir, "final.json"), {
      version: 1,
      runId,
      outcome,
      finishedAt: this.now().toISOString(),
      ...(detail === undefined ? {} : { detail }),
      ...(sha === undefined ? {} : { sha }),
    })
  }
}

async function runLiveness(ledger: FactsRunLedger): Promise<"alive" | "dead" | "unknown"> {
  const identities = [
    [ledger.pid, ledger.processStart],
    [ledger.childPid, ledger.childProcessStart],
  ] as const
  let unknown = false
  for (const [pid, expectedStart] of identities) {
    if (pid === undefined) {
      unknown = true
      continue
    }
    const liveness = getPidLiveness(pid)
    if (liveness === "dead") continue
    if (liveness === "unknown" || expectedStart === null || expectedStart === undefined) {
      unknown = true
      continue
    }
    const actualStart = await getProcessStartIdentity(pid)
    if (actualStart === null) unknown = true
    else if (actualStart === expectedStart) return "alive"
  }
  return unknown ? "unknown" : "dead"
}

function queueKeys(entries: readonly FactsQueueEntry[]) {
  return entries.map((entry) => ({
    conversationId: entry.conversationId,
    end_message_id: entry.range.end_message_id,
  }))
}

function finalResult(record: FactsFinalRecord): FactsLaunchResult {
  if (record.outcome === "committed" && record.sha !== undefined) {
    return { status: "committed", runId: record.runId, sha: record.sha }
  }
  return { status: record.outcome === "no_facts" ? "no_facts" : "failed", runId: record.runId }
}

function delay(_attempt: number, milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error ? String(error.code) : undefined
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
