import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { basename, join } from "node:path"

import {
  FactsFailureStore,
  FactsQueue,
  GitMemoryRepo,
  buildDefaultSeedFiles,
  createLockRecord,
  memoryWriterLockPath,
  withLock,
  type FactsFailureReason,
  type FactsPayload,
} from "@oh-my-opencode/memory-core"
import { ledgerTargets, preflightFailureId, queueEntryTargets } from "./facts-failure-recording"
import { FactsTerminalWrites } from "./facts-terminal-writes"
import { readFactsPeoplePayload } from "./facts-people-payload"
import { SandboxUnavailableError } from "./sandbox-contracts"
import { launchFactsModelChain } from "./worker/facts-child-launch"
import { resolveReflectionModel } from "./worker/resolve-model"
import { readRunJson } from "./worker/run-artifacts"

const QUICK_CATEGORY = "quick"
const DEFAULT_DEADLINE_MS = 15 * 60_000
const WRITER_WAIT_MS = 2_000

export type { FactsExtractorRunnerOptions, FactsLaunchResult } from "./facts-runner-types"
import type { FactsExtractorRunnerOptions, FactsFinalRecord, FactsLaunchResult, FactsRunLedger } from "./facts-runner-types"
import { describe, finalResult, queueKeys, reserveFactsRunDir } from "./facts-run-storage"
import { finalizeClaimedFactsRun } from "./facts-run-finalize"
import { reconcileFactsRuns } from "./facts-run-reconcile"

export class FactsExtractorRunner {
  private readonly queue: FactsQueue
  private readonly now: () => Date
  private readonly terminal: FactsTerminalWrites
  private activeLaunch: Promise<FactsLaunchResult> | undefined

  constructor(private readonly options: FactsExtractorRunnerOptions) {
    this.queue = options.queue ?? new FactsQueue({ identityPaths: options.identity.paths })
    this.now = options.now ?? (() => new Date())
    this.terminal = new FactsTerminalWrites({
      failures: options.failures ?? new FactsFailureStore({ identityPaths: options.identity.paths, now: this.now }),
      now: this.now,
      markConsumed: (entries) => this.queue.markConsumed(entries),
      ...(options.writeTerminalSentinel === undefined ? {} : { write: options.writeTerminalSentinel }),
      ...(options.logger === undefined ? {} : { warn: (message, fields) => options.logger?.warn(message, fields) }),
    })
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
      await this.terminal.preflightFail(
        queueEntryTargets(entries),
        preflightFailureId(this.options.createPreflightId),
        "quick_category_unavailable",
        resolution.cause,
      )
      return { status: "skipped" }
    }

    const repo = new GitMemoryRepo({ dir: this.options.identity.paths.repo, agentId: this.options.identity.id })
    if (!existsSync(join(repo.dir, ".git"))) await repo.init({ seedFiles: buildDefaultSeedFiles() })
    const batchId = (this.options.createBatchId ?? randomUUID)()
    const launchedAt = this.now().getTime()
    if (isAborted()) return { status: "skipped" }
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
    if (isAborted()) return { status: "skipped" }
    try {
      const { child } = await launchFactsModelChain({
        runId,
        runDir,
        payload,
        resolution,
        env: this.options.env ?? process.env,
        configSources: loaded.sources,
        warn: (message, details) => this.options.logger?.warn(message, details),
        senpiCommand: this.options.senpiCommand,
        senpiPrefixArgs: this.options.senpiPrefixArgs,
        resolveAndPreflightLaunch: this.options.resolveAndPreflightLaunch,
        hardDeadlineAt: Date.now() + (this.options.deadlineMs ?? DEFAULT_DEADLINE_MS),
        terminationGraceMs: this.options.terminationGraceMs,
        maxOutputBytes: this.options.maxOutputBytes,
        sandbox: this.options.sandbox,
        supervisorPath: this.options.supervisorPath,
        batchId,
        queued: queueKeys(entries),
        launchedAt,
      })
      if (child.timedOut || child.code !== 0) {
        const reason: FactsFailureReason = child.timedOut ? "deadline_exceeded" : "child_exit"
        const detail = child.stderr.trim() || "facts child failed"
        await this.terminal.fail({ runDir, runId, targets: queueEntryTargets(entries), reason, detail })
        return { status: "failed", runId }
      }
    } catch (error) {
      const reason: FactsFailureReason = error instanceof SandboxUnavailableError ? "sandbox_unavailable" : "child_exit"
      await this.terminal.fail({ runDir, runId, targets: queueEntryTargets(entries), reason, detail: describe(error) })
      return { status: "failed", runId }
    }
    return this.finalizeRun(runDir, repo)
  }

  private reconcileRuns(): Promise<boolean> {
    return reconcileFactsRuns({
      factsDir: this.options.identity.paths.facts,
      now: this.now,
      finalize: async (runDir) => {
        const repo = new GitMemoryRepo({ dir: this.options.identity.paths.repo, agentId: this.options.identity.id })
        await this.finalizeRun(runDir, repo)
      },
      fail: (runDir, ledger, detail) => this.terminal.fail({
        runDir,
        runId: ledger.runId,
        targets: ledgerTargets(ledger.queued),
        reason: "child_exit",
        detail,
      }),
      abandon: (runDir, ledger, reason) => this.terminal.abandon(runDir, ledger, reason),
      warn: (message, fields) => this.options.logger?.warn(message, fields),
    })
  }

  private async finalizeRun(runDir: string, repo: GitMemoryRepo): Promise<FactsLaunchResult> {
    const ledger = await readRunJson<FactsRunLedger>(join(runDir, "ledger.json"))
    const record = await createLockRecord("facts-finalize", { runId: ledger.runId })
    return withLock(join(this.options.identity.paths.locks, `finalize-${ledger.runId}.lock`), record, async () => {
      const finalPath = join(runDir, "final.json")
      if (existsSync(finalPath)) return finalResult(await readRunJson<FactsFinalRecord>(finalPath))
      if (existsSync(join(runDir, "abandoned.json"))) return { status: "failed", runId: ledger.runId }
      return finalizeClaimedFactsRun({
        runDir,
        repo,
        ledger,
        identity: this.options.identity,
        terminal: this.terminal,
        options: this.options,
        ...(this.options.logger === undefined ? {} : { logger: this.options.logger }),
        withWriterLock: (operation, attempt) => this.withWriterLock(operation, attempt),
      })
    }, { waitTimeoutMs: WRITER_WAIT_MS })
  }

  private async withWriterLock<T>(operation: () => Promise<T>, attempt: number): Promise<T> {
    if (this.options.withWriterLock !== undefined) return this.options.withWriterLock(operation, attempt)
    const record = await createLockRecord("memory-write", { runId: `facts-${attempt}` })
    return withLock(memoryWriterLockPath(this.options.identity.paths.locks), record, operation, {
      waitTimeoutMs: WRITER_WAIT_MS,
    })
  }

}
