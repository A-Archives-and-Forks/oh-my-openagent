import { existsSync } from "node:fs"
import { join } from "node:path"

import type { OmoConfig } from "@oh-my-opencode/omo-config-core"
import {
  GitMemoryRepo,
  buildDefaultSeedFiles,
  cleanupReflectionWorktree,
  installHooks,
  type ReflectionFinalizeResult,
  type ReflectionWorktree,
  type ReservedRun,
} from "@oh-my-opencode/memory-core"
import { loadSenpiOmoConfig, type SenpiOmoConfigResult } from "../../config-resolution"
import { resolveAgentReflectionSettings } from "../reflection-settings"
import { createOncePerSessionGuard } from "../../task/usage-guidance"
import {
  recordReflectionCompletion,
  registerReflectionCompletionRenderer,
  type ReflectionCompletionRecord,
  type ReflectionLiveSession,
} from "./completion"
import {
  resolveReflectionModel,
  shouldWarnCategoryUnavailable,
  type ReflectionModelResolution,
} from "./resolve-model"
import {
  runMemoryModelAttempts,
  type MemoryModelChain,
} from "./memory-model-attempts"
import { createRunWorktree } from "./create-run-worktree"
import { prepareReflectionCandidateSpawn } from "./reflection-spawn-input"
import { readRunJson } from "./run-artifacts"
import { failReservationRun, finalizeRecordedOutcome } from "./run-finalization"
import type { RunFinalizationContext } from "./run-finalization-types"
import { parseReservationRunLedger } from "./reservation-run-ledger"
import { requireFinalizedResult } from "./runner-finalization-result"
import { runReflectionChild } from "./spawn"

export type {
  ReflectionReservationPort,
  ReflectionRunResult,
  ReflectionRunner,
  SenpiSubprocessRunnerOptions,
} from "./runner-types"

import { cleanupSucceeded, errorMessage } from "./runner-results"
import type { ExecutionResult, ReflectionRunResult, ReflectionRunner, SenpiSubprocessRunnerOptions } from "./runner-types"

export class SenpiSubprocessRunner implements ReflectionRunner {
  private readonly loadConfig: (options?: { readonly cwd?: string }) => SenpiOmoConfigResult
  private readonly now: () => Date
  private readonly warnedCategory = createOncePerSessionGuard()
  private readonly registeredApis = new WeakSet<object>()

  constructor(private readonly options: SenpiSubprocessRunnerOptions) {
    this.loadConfig = options.loadConfig ?? loadSenpiOmoConfig
    this.now = options.now ?? (() => new Date())
    this.ensureRenderer(options.liveSession?.())
  }

  async launch(run: ReservedRun): Promise<ReflectionRunResult> {
    const startedAt = this.now().toISOString()
    const cwd = this.options.cwd ?? process.cwd()
    const loaded = this.loadConfig({ cwd })
    const reflection = resolveAgentReflectionSettings(loaded.config.memory, this.options.identity.id)
    const category = reflection.category
    const resolution = resolveReflectionModel(category, loaded.config, this.options.resolveModelRegistry())

    if (resolution.kind === "category_unavailable") {
      this.notifyCategoryUnavailable(loaded.config, resolution)
      return this.settle(run, {
        outcome: "failed",
        reason: "category_unavailable",
        detail: `Reflection category "${category}" could not resolve a usable model (cause: ${resolution.cause})`,
      }, startedAt, resolution, true)
    }

    const execution = await this.execute(run, resolution, loaded)
    if ("runId" in execution) return this.deliverFinalized(execution)
    const settled = await this.settle(run, execution, startedAt, resolution, false)
    return settled
  }

  private async execute(
    run: ReservedRun,
    resolution: Extract<ReflectionModelResolution, { readonly kind: "resolved" }>,
    loaded: SenpiOmoConfigResult,
  ): Promise<ExecutionResult | ReflectionRunResult> {
    const repo = new GitMemoryRepo({ dir: this.options.identity.paths.repo, agentId: this.options.identity.id })
    if (!existsSync(join(this.options.identity.paths.repo, ".git"))) {
      await repo.init({ seedFiles: buildDefaultSeedFiles(), installHooks: (dir) => { installHooks(dir) } })
    }
    let worktree: ReflectionWorktree | undefined
    try {
      worktree = await createRunWorktree(repo, run.runId, this.options.identity.paths)
      const activeWorktree = worktree
      const reflection = resolveAgentReflectionSettings(loaded.config.memory, this.options.identity.id)
      const merge = reflection.merge
      const hardDeadlineAt = Date.now() + (this.options.deadlineMs ?? reflection.timeout_minutes * 60_000)
      const candidates: MemoryModelChain = [
        {
          model: resolution.model,
          ...(resolution.thinking === undefined ? {} : { thinking: resolution.thinking }),
        },
        ...resolution.fallbacks,
      ]
      await runMemoryModelAttempts(candidates, async (candidate, attemptNumber, nextAttempt) => {
        const spawnArgs = await prepareReflectionCandidateSpawn({
          run,
          worktree: activeWorktree,
          mergePolicy: merge,
          category: reflection.category,
          candidate,
          attempt: attemptNumber,
          hardDeadlineAt,
          nextAttempt,
          config: loaded.config,
          identity: this.options.identity,
          env: this.options.env ?? process.env,
          senpiCommand: this.options.senpiCommand,
        })
        return runReflectionChild(spawnArgs, {
          terminationGraceMs: this.options.terminationGraceMs,
          maxOutputBytes: this.options.maxOutputBytes,
          sandbox: this.options.sandbox,
          supervisorPath: this.options.supervisorPath,
        })
      })
    } catch (error) {
      const runDir = join(this.options.identity.paths.reflection, "runs", run.runId)
      if (existsSync(join(runDir, "ledger.json"))) {
        const ledger = parseReservationRunLedger(await readRunJson<unknown>(join(runDir, "ledger.json")))
        const finalized = await failReservationRun(
          this.finalizationContext(),
          runDir,
          ledger,
          "failed",
          errorMessage(error),
        )
        return requireFinalizedResult(finalized)
      }
      const discarded = worktree === undefined ? undefined : await this.discard(worktree)
      return {
        outcome: "failed",
        reason: discarded !== undefined && !cleanupSucceeded(discarded) ? "cleanup_failed" : "spawn_failed",
        detail: [errorMessage(error), discarded?.detail].filter(Boolean).join("; "),
      }
    }
    const runDir = join(this.options.identity.paths.reflection, "runs", run.runId)
    const ledger = parseReservationRunLedger(await readRunJson<unknown>(join(runDir, "ledger.json")))
    const finalized = await finalizeRecordedOutcome(this.finalizationContext(), runDir, ledger)
    return requireFinalizedResult(finalized)
  }

  private async settle(
    run: ReservedRun,
    result: ExecutionResult,
    startedAt: string,
    resolution: ReflectionModelResolution,
    suppressCompletionNotification: boolean,
  ): Promise<ReflectionRunResult> {
    const transition = await this.options.reservation.complete(run.runId, result.outcome)
    const live = this.options.liveSession?.()
    this.ensureRenderer(live)
    const record: ReflectionCompletionRecord = {
      schemaVersion: 1,
      runId: run.runId,
      identity: this.options.identity.id,
      category: resolution.category,
      ...(resolution.kind === "resolved"
        ? {
            model: result.model ?? resolution.model,
            ...(result.model === undefined
              ? resolution.thinking === undefined ? {} : { thinking: resolution.thinking }
              : result.thinking === undefined ? {} : { thinking: result.thinking }),
          }
        : {}),
      conversationIds: run.request.conversationIds,
      trigger: run.request.trigger,
      ...(run.request.trigger === "dream" ? { origin: run.request.origin } : {}),
      outcome: result.outcome,
      ...(result.reason === undefined ? {} : { reason: result.reason }),
      ...(result.detail === undefined ? {} : { detail: result.detail }),
      startedAt,
      finishedAt: this.now().toISOString(),
      delivery: { status: "pending" },
    }
    const completion = await recordReflectionCompletion(
      join(this.options.identity.paths.reflection, "completions"),
      record,
      suppressCompletionNotification && live ? { sessionId: live.sessionId, api: live.api } : live,
    )
    return {
      runId: run.runId,
      outcome: result.outcome,
      ...(result.reason === undefined ? {} : { reason: result.reason }),
      ...(result.detail === undefined ? {} : { detail: result.detail }),
      completion,
      ...(transition.launch === undefined ? {} : { launch: transition.launch }),
    }
  }

  private async deliverFinalized(result: ReflectionRunResult): Promise<ReflectionRunResult> {
    const live = this.options.liveSession?.()
    this.ensureRenderer(live)
    const completion = await recordReflectionCompletion(
      join(this.options.identity.paths.reflection, "completions"),
      result.completion,
      live,
    )
    return { ...result, completion }
  }

  private notifyCategoryUnavailable(config: OmoConfig, resolution: Extract<ReflectionModelResolution, { readonly kind: "category_unavailable" }>): void {
    const live = this.options.liveSession?.()
    if (!live?.ui || !shouldWarnCategoryUnavailable(config, resolution.category)) return
    if (!this.warnedCategory(`${live.sessionId}:${resolution.category}`)) return
    const providers = resolution.missingProviders?.join(", ")
    live.ui.notify(
      providers
        ? `Category "${resolution.category}" has no usable model: none of its fallback-chain providers are connected (${providers}).`
        : `Category "${resolution.category}" has no usable model for memory reflection.`,
      "warning",
    )
  }

  private ensureRenderer(live: ReflectionLiveSession | undefined): void {
    if (!live || this.registeredApis.has(live.api)) return
    registerReflectionCompletionRenderer(live.api)
    this.registeredApis.add(live.api)
  }

  private async discard(worktree: ReflectionWorktree): Promise<ReflectionFinalizeResult> {
    const cleanup = await cleanupReflectionWorktree(worktree)
    return { status: "failed", cleanup }
  }

  private finalizationContext(): RunFinalizationContext {
    return {
      identity: this.options.identity,
      reservation: this.options.reservation,
      now: () => this.now().getTime(),
      ...(this.options.withWriterLock === undefined
        ? {}
        : { withWriterLock: this.options.withWriterLock }),
    }
  }
}
