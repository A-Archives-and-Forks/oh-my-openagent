import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { readFile, readdir } from "node:fs/promises"
import { basename, join } from "node:path"

import {
  FactsQueue,
  GitMemoryRepo,
  buildDefaultSeedFiles,
  createLockRecord,
  memoryWriterLockPath,
  parseFactsExtractionJsonl,
  withLock,
  type FactsPayload,
  type FactsQueueEntry,
} from "@oh-my-opencode/memory-core"
import { readFactsPeoplePayload } from "./facts-people-payload"
import { resolveReflectionModel } from "./worker/resolve-model"
import {
  prepareFactsSpawn,
  runFactsChild,
} from "./worker/spawn"
import { readRunJson, updateRunLedger, writeRunJsonAtomic, type RunOutcome } from "./worker/run-artifacts"

const QUICK_CATEGORY = "quick"
const DEFAULT_DEADLINE_MS = 15 * 60_000
const WRITER_WAIT_MS = 2_000

export type { FactsExtractorRunnerOptions, FactsLaunchResult } from "./facts-runner-types"
import type { FactsExtractorRunnerOptions, FactsFinalRecord, FactsLaunchResult, FactsRunLedger } from "./facts-runner-types"
import { describe, finalResult, queueKeys, reserveFactsRunDir, runLiveness, writeFactsFinal } from "./facts-run-storage"
import { applyFactsWithRetries, resolveFactsPeopleRouting } from "./facts-batch-apply"

export class FactsExtractorRunner {
  private readonly queue: FactsQueue
  private readonly now: () => Date
  private activeLaunch: Promise<FactsLaunchResult> | undefined

  constructor(private readonly options: FactsExtractorRunnerOptions) {
    this.queue = options.queue ?? new FactsQueue({ identityPaths: options.identity.paths })
    this.now = options.now ?? (() => new Date())
  }

  async launchPending(signal?: AbortSignal): Promise<FactsLaunchResult> {
    if (signal?.aborted === true) return { status: "skipped" }
    if (this.activeLaunch !== undefined) return { status: "active" }
    const operation = this.launchPendingOnce(signal)
    this.activeLaunch = operation
    try {
      return await operation
    } finally {
      if (this.activeLaunch === operation) this.activeLaunch = undefined
    }
  }

  async reconcilePending(signal?: AbortSignal): Promise<FactsLaunchResult> {
    const active = await this.reconcileRuns()
    if (active) return { status: "active" }
    return this.launchPending(signal)
  }

  private async launchPendingOnce(signal?: AbortSignal): Promise<FactsLaunchResult> {
    const isAborted = (): boolean => signal?.aborted === true
    if (isAborted()) return { status: "skipped" }
    if (await this.reconcileRuns()) return { status: "active" }
    const entries = await this.queue.listPending()
    if (isAborted()) return { status: "skipped" }
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
    const runDir = await reserveFactsRunDir({
      factsDir: this.options.identity.paths.facts,
      entries,
      batchId,
      launchedAt,
      deadlineMs: this.options.deadlineMs,
      terminationGraceMs: this.options.terminationGraceMs,
    })
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

    if (isAborted()) return { status: "skipped" }
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

    let applied
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

  private applyWithRetries(
    runDir: string,
    ledger: FactsRunLedger,
    repo: GitMemoryRepo,
    records: ReturnType<typeof parseFactsExtractionJsonl>,
  ) {
    return applyFactsWithRetries({
      runDir,
      ledger,
      repo,
      records,
      people: resolveFactsPeopleRouting(this.options.loadConfig().config, this.options.identity.id),
      identity: this.options.identity,
      logger: this.options.logger,
      withWriterLock: (operation, attempt) => this.withWriterLock(operation, attempt),
      retryDelay: this.options.retryDelay,
      random: this.options.random,
    })
  }

  private async withWriterLock<T>(operation: () => Promise<T>, attempt: number): Promise<T> {
    if (this.options.withWriterLock !== undefined) return this.options.withWriterLock(operation, attempt)
    const record = await createLockRecord("memory-write", { runId: `facts-${attempt}` })
    return withLock(memoryWriterLockPath(this.options.identity.paths.locks), record, operation, {
      waitTimeoutMs: WRITER_WAIT_MS,
    })
  }

  private async writeFinal(
    runDir: string,
    runId: string,
    outcome: "committed" | "no_facts" | "failed",
    detail?: string,
    sha?: string,
  ): Promise<void> {
    await writeFactsFinal({ runDir, runId, outcome, now: this.now, detail, sha })
  }
}
