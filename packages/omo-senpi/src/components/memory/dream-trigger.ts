// Dream trigger wiring (plan todo 12): opportunistic dream launches from idle, shutdown, and
// manual origins. Automatic origins (idle, shutdown) pass three gates - dream.enabled,
// min_hours_between since the last completed dream, and the unreflected-volume floor - while the
// manual origin bypasses all three (letta manual-unconditional parity); todo 14 owns the manual
// call site, this module ships the bypass path. The idle detector is an in-extension timer armed
// on agent_settled, reset by input/agent_start/session_compact, and cancelled by
// session_shutdown/session_abort; it fires only while the host still reports idle with no pending
// messages. No native session_idle listener is registered: ExtensionAPI has no such overload
// today, and todo 21 retires this timer only once a native event reports
// idleMs >= dream.idle_minutes * 60_000. A fire requests a dream launch through the todo 13
// reservation machine; only the run that wins the active slot launches now.

import { readFile } from "node:fs/promises"
import { join } from "node:path"

import type {
  CapturedConversation,
  DreamOrigin,
  MemoryIdentityPaths,
  ReservedRun,
  ReflectionReservationStore,
  TranscriptJournal,
} from "@oh-my-opencode/memory-core"
import type { OmoMemorySettings } from "@oh-my-opencode/omo-config-core"

import type { ComponentLogger, SenpiExtensionAPI } from "../../extension/types"
import { computeUnreflectedVolume, selectDreamConversations } from "./dream-selector"
import type { ShutdownEvaluator } from "./shutdown-drain"

/** Unreflected-volume floor for automatic dream origins, in UTF-8 bytes (plan todo 24). */
export const DREAM_VOLUME_GATE_BYTES = 8192

export interface DreamTriggerSettings {
  readonly enabled: boolean
  readonly idleMinutes: number
  readonly minHoursBetween: number
  readonly shutdownLaunch: boolean
  readonly autoSelectMax: number
  readonly autoSelectMaxChars: number
}

export const DEFAULT_DREAM_TRIGGER_SETTINGS: DreamTriggerSettings = {
  enabled: true,
  idleMinutes: 30,
  minHoursBetween: 24,
  shutdownLaunch: true,
  autoSelectMax: 5,
  autoSelectMaxChars: 150000,
}

/** Resolved dream policy for the bound identity: per-agent overrides win field by field. */
export function resolveDreamTriggerSettings(settings: OmoMemorySettings, agentName?: string): DreamTriggerSettings {
  const base = settings.dream
  const override = agentName === undefined ? undefined : settings.agents[agentName]?.dream
  return {
    enabled: override?.enabled ?? base.enabled,
    idleMinutes: override?.idle_minutes ?? base.idle_minutes,
    minHoursBetween: override?.min_hours_between ?? base.min_hours_between,
    shutdownLaunch: override?.shutdown_launch ?? base.shutdown_launch,
    autoSelectMax: override?.auto_select_max ?? base.auto_select_max,
    autoSelectMaxChars: override?.auto_select_max_chars ?? base.auto_select_max_chars,
  }
}

export type DreamGateRejection = "disabled" | "shutdown_disabled" | "too_soon" | "insufficient_volume"

export type DreamGateDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly rejection: DreamGateRejection }

/** Lazily probed gate inputs so an early rejection never pays for a later probe. */
export interface DreamGateProbe {
  readonly nowMs: number
  readonly lastDreamAtMs: () => Promise<number | null>
  readonly unreflectedBytes: () => Promise<number>
}

/**
 * The single dream gate evaluation. Manual origin bypasses all three automatic gates; idle and
 * shutdown origins must pass dream.enabled, the min_hours_between spacing (strictly greater),
 * and the unreflected-volume floor (strictly greater than 8192 bytes). Shutdown additionally
 * requires shutdown_launch.
 */
export async function evaluateDreamGates(
  origin: DreamOrigin,
  settings: DreamTriggerSettings,
  probe: DreamGateProbe,
): Promise<DreamGateDecision> {
  if (origin === "manual") return { allowed: true }
  if (!settings.enabled) return { allowed: false, rejection: "disabled" }
  if (origin === "shutdown" && !settings.shutdownLaunch) return { allowed: false, rejection: "shutdown_disabled" }
  const lastDreamAtMs = await probe.lastDreamAtMs()
  if (lastDreamAtMs !== null && probe.nowMs - lastDreamAtMs <= settings.minHoursBetween * 3_600_000) {
    return { allowed: false, rejection: "too_soon" }
  }
  if ((await probe.unreflectedBytes()) <= DREAM_VOLUME_GATE_BYTES) {
    return { allowed: false, rejection: "insufficient_volume" }
  }
  return { allowed: true }
}

/** Reads the todo 13 dream ledger (runtime/dream/state.json); absent or malformed means never. */
export async function readLastDreamAtMs(runtimeDir: string): Promise<number | null> {
  let raw: string
  try {
    raw = await readFile(join(runtimeDir, "dream", "state.json"), "utf8")
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null
    throw error
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed) || typeof parsed.last_dream_at !== "string") return null
    const parsedMs = Date.parse(parsed.last_dream_at)
    return Number.isFinite(parsedMs) ? parsedMs : null
  } catch (error) {
    if (error instanceof SyntaxError) return null
    throw error
  }
}

/** Per-session dream state the wiring evaluates against. */
export interface DreamTriggerSession {
  readonly conversationId: string
  readonly identity: string
  readonly identityPaths: MemoryIdentityPaths
  readonly getJournal: (conversationId: string) => Promise<TranscriptJournal>
  readonly store: Pick<ReflectionReservationStore, "tryReserve">
  readonly launch: (run: ReservedRun) => void
}

/** Timer seam; tests inject a deterministic scheduler. */
export interface DreamTriggerScheduler {
  schedule(fire: () => void, delayMs: number): unknown
  cancel(handle: unknown): void
}

const defaultScheduler: DreamTriggerScheduler = {
  schedule: (fire, delayMs) => {
    const timer = setTimeout(fire, delayMs)
    // An idle-detection timer must never keep the host process alive.
    timer.unref()
    return timer
  },
  cancel: (handle) => {
    clearTimeout(handle as Parameters<typeof clearTimeout>[0])
  },
}

export type DreamFireRejection = DreamGateRejection | "no_unreflected_content" | "no_session" | "aborted"

export type DreamFireOutcome =
  | { readonly fired: true; readonly runId: string; readonly status: "active" | "pending" }
  | { readonly fired: false; readonly rejection: DreamFireRejection }

export interface ManualDreamRequest {
  readonly focus?: string
  readonly conversationIds?: readonly string[]
  readonly targetDoc?: string
}

export interface DreamTriggerWiringOptions {
  /** Resolves the bound session for a host event; undefined means memory is not active there. */
  readonly resolveSession: (eventCtx?: unknown) => DreamTriggerSession | undefined
  /** Resolves the foreground session for the manual path (todo 14's /dream call site). */
  readonly resolveActiveSession: () => DreamTriggerSession | undefined
  /** Resolves a session by id for the shutdown evaluator, which has no event context. */
  readonly resolveSessionById: (sessionId: string) => DreamTriggerSession | undefined
  readonly resolveSettings: (identity: string) => DreamTriggerSettings
  readonly now?: () => number
  readonly scheduler?: DreamTriggerScheduler
  readonly logger?: ComponentLogger
}

export interface DreamTriggerWiring {
  register(pi: SenpiExtensionAPI): void
  /** IC-10 evaluator for todo 10's drain; the drain runs it only on quit, after the fixed steps. */
  shutdownEvaluator(): ShutdownEvaluator
  /** Manual entrypoint for todo 14's /dream. Bypasses every automatic gate. */
  requestManualDream(request?: ManualDreamRequest): Promise<DreamFireOutcome>
  /** Resolves once every fire started so far has finished. */
  whenIdle(): Promise<void>
}

export function createDreamTriggerWiring(options: DreamTriggerWiringOptions): DreamTriggerWiring {
  const now = options.now ?? Date.now
  const scheduler = options.scheduler ?? defaultScheduler
  const timers = new Map<string, { readonly handle: unknown; readonly eventCtx: unknown }>()
  const inFlight = new Set<Promise<void>>()

  function track(task: () => Promise<void>): void {
    const promise = task()
      .catch((error: unknown) => {
        options.logger?.warn("omo-senpi memory dream trigger failed", { error: describe(error) })
      })
      .finally(() => {
        inFlight.delete(promise)
      })
    inFlight.add(promise)
  }

  function cancelTimer(conversationId: string): void {
    const state = timers.get(conversationId)
    if (state === undefined) return
    timers.delete(conversationId)
    scheduler.cancel(state.handle)
  }

  function arm(session: DreamTriggerSession, eventCtx: unknown): void {
    cancelTimer(session.conversationId)
    const settings = options.resolveSettings(session.identity)
    if (settings.idleMinutes <= 0) return
    const handle = scheduler.schedule(() => fire(session.conversationId), settings.idleMinutes * 60_000)
    timers.set(session.conversationId, { handle, eventCtx })
  }

  function resetFor(eventCtx: unknown): void {
    const session = options.resolveSession(eventCtx)
    if (session === undefined) return
    cancelTimer(session.conversationId)
  }

  function fire(conversationId: string): void {
    const state = timers.get(conversationId)
    if (state === undefined) return
    timers.delete(conversationId)
    if (!isIdleNow(state.eventCtx)) return
    const session = options.resolveSession(state.eventCtx)
    if (session === undefined || session.conversationId !== conversationId) return
    track(async () => {
      await fireDream(session, "idle", options.resolveSettings(session.identity), {})
    })
  }

  async function fireDream(
    session: DreamTriggerSession,
    origin: DreamOrigin,
    settings: DreamTriggerSettings,
    request: ManualDreamRequest & { readonly signal?: AbortSignal },
  ): Promise<DreamFireOutcome> {
    const decision = await evaluateDreamGates(origin, settings, {
      nowMs: now(),
      lastDreamAtMs: () => readLastDreamAtMs(session.identityPaths.runtime),
      unreflectedBytes: () => computeUnreflectedVolume({
        transcriptsDir: session.identityPaths.transcripts,
        autoSelectMax: settings.autoSelectMax,
        autoSelectMaxBytes: settings.autoSelectMaxChars,
        now: () => new Date(now()),
      }),
    })
    if (!decision.allowed) return { fired: false, rejection: decision.rejection }
    if (isAborted(request.signal)) return { fired: false, rejection: "aborted" }
    const selected = request.conversationIds === undefined
      ? (await selectDreamConversations({
          transcriptsDir: session.identityPaths.transcripts,
          currentConversationId: session.conversationId,
          autoSelectMax: settings.autoSelectMax,
          autoSelectMaxBytes: settings.autoSelectMaxChars,
          now: () => new Date(now()),
        }, { ...(request.focus === undefined ? {} : { focus: request.focus }) })).conversationIds
      : request.conversationIds
    const conversationIds: string[] = []
    const snapshots: CapturedConversation[] = []
    for (const conversationId of selected) {
      const snapshot = await (await session.getJournal(conversationId)).captureReflectionSnapshot()
      if (snapshot === null) continue
      conversationIds.push(conversationId)
      snapshots.push({ conversationId, snapshot })
    }
    if (conversationIds.length === 0) return { fired: false, rejection: "no_unreflected_content" }
    if (isAborted(request.signal)) return { fired: false, rejection: "aborted" }
    const result = await session.store.tryReserve({
      trigger: "dream",
      origin,
      conversationIds,
      snapshots,
      ...(request.focus === undefined ? {} : { focus: request.focus }),
      ...(request.targetDoc === undefined ? {} : { targetDoc: request.targetDoc }),
    })
    if (result.status === "active") {
      try {
        session.launch(result.run)
      } catch (error: unknown) {
        options.logger?.warn("omo-senpi memory dream launch failed", { error: describe(error) })
      }
    }
    return { fired: true, runId: result.run.runId, status: result.status }
  }

  return {
    register(pi: SenpiExtensionAPI): void {
      pi.on("agent_settled", (_payload, eventCtx) => {
        const session = options.resolveSession(eventCtx)
        if (session === undefined) return
        arm(session, eventCtx)
      })
      pi.on("input", (_payload, eventCtx) => resetFor(eventCtx))
      pi.on("agent_start", (_payload, eventCtx) => resetFor(eventCtx))
      pi.on("session_compact", (_payload, eventCtx) => resetFor(eventCtx))
      pi.on("session_shutdown", (_payload, eventCtx) => resetFor(eventCtx))
      pi.on("session_abort", (_payload, eventCtx) => resetFor(eventCtx))
    },

    shutdownEvaluator(): ShutdownEvaluator {
      return async (input) => {
        if (input.signal.aborted) return
        const session = options.resolveSessionById(input.sessionId)
        if (session === undefined) return
        await fireDream(session, "shutdown", options.resolveSettings(session.identity), { signal: input.signal })
      }
    },

    async requestManualDream(request: ManualDreamRequest = {}): Promise<DreamFireOutcome> {
      const session = options.resolveActiveSession()
      if (session === undefined) return { fired: false, rejection: "no_session" }
      return fireDream(session, "manual", options.resolveSettings(session.identity), request)
    },

    async whenIdle(): Promise<void> {
      while (inFlight.size > 0) await Promise.all([...inFlight])
    },
  }
}

/** Live read of the drain signal: AbortSignal.aborted mutates externally, so it is never narrowed. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

/** Fail-closed idle probe: a context without both probes can never report idle. */
function isIdleNow(eventCtx: unknown): boolean {
  if (!isRecord(eventCtx)) return false
  const isIdle = eventCtx.isIdle
  const hasPending = eventCtx.hasPendingMessages
  if (typeof isIdle !== "function" || typeof hasPending !== "function") return false
  return Reflect.apply(isIdle, eventCtx, []) === true && Reflect.apply(hasPending, eventCtx, []) === false
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !("code" in error)) return undefined
  return typeof error.code === "string" ? error.code : undefined
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
