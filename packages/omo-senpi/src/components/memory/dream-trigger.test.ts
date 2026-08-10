import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  buildIdentityPaths,
  ReflectionReservationStore,
  TranscriptJournal,
  type MemoryIdentity,
  type ReservedRun,
  type TranscriptEntry,
} from "@oh-my-opencode/memory-core"

import { FakeExtensionAPI } from "../../../test-support/fake-extension-api"
import {
  createDreamTriggerWiring,
  DEFAULT_DREAM_TRIGGER_SETTINGS,
  DREAM_VOLUME_GATE_BYTES,
  evaluateDreamGates,
  resolveDreamTriggerSettings,
  type DreamGateProbe,
  type DreamTriggerSession,
  type DreamTriggerSettings,
} from "./dream-trigger"
import { memorySettings } from "./memory.test-support"
import { createShutdownDrain, type ShutdownDrainSteps } from "./shutdown-drain"

const CONVERSATION = "conversation-a"
const NOW_MS = Date.parse("2026-08-10T12:00:00.000Z")
const IDLE_MS = 30 * 60_000

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function triggerSettings(overrides: Partial<DreamTriggerSettings> = {}): DreamTriggerSettings {
  return { ...DEFAULT_DREAM_TRIGGER_SETTINGS, ...overrides }
}

interface FakeScheduled {
  readonly handle: number
  readonly delayMs: number
  readonly fire: () => void
  cancelled: boolean
}

/** Deterministic timer seam: scheduled callbacks run only when the test invokes them. */
class FakeScheduler {
  readonly scheduled: FakeScheduled[] = []
  private nextHandle = 0

  schedule(fire: () => void, delayMs: number): unknown {
    const entry: FakeScheduled = { handle: ++this.nextHandle, delayMs, fire, cancelled: false }
    this.scheduled.push(entry)
    return entry.handle
  }

  cancel(handle: unknown): void {
    const entry = this.scheduled.find((candidate) => candidate.handle === handle)
    if (entry !== undefined) entry.cancelled = true
  }

  latest(): FakeScheduled {
    const entry = this.scheduled.at(-1)
    if (entry === undefined) throw new Error("expected a scheduled timer")
    return entry
  }
}

interface Fixture {
  readonly pi: FakeExtensionAPI
  readonly scheduler: FakeScheduler
  readonly store: ReflectionReservationStore
  readonly launches: ReservedRun[]
  readonly idleState: { isIdle: boolean; hasPending: boolean }
  readonly eventCtx: unknown
  readonly wiring: ReturnType<typeof createDreamTriggerWiring>
  readonly identity: MemoryIdentity
}

async function fixture(options: {
  readonly settings?: Partial<DreamTriggerSettings>
  readonly lastDreamAt?: string
  readonly conversationText?: string | null
  readonly reservationStore?: DreamTriggerSession["store"]
} = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "omo-dream-trigger-"))
  roots.push(root)
  const identity: MemoryIdentity = { id: "agent-test", safeSlug: "agent-test", paths: buildIdentityPaths(root, "agent-test") }
  const text = options.conversationText === undefined ? "x".repeat(DREAM_VOLUME_GATE_BYTES + 1) : options.conversationText
  if (text !== null) await writeConversation(identity.paths.transcripts, CONVERSATION, text)
  if (options.lastDreamAt !== undefined) {
    const dreamDir = join(identity.paths.runtime, "dream")
    await mkdir(dreamDir, { recursive: true })
    await writeFile(join(dreamDir, "state.json"), `${JSON.stringify({ last_dream_at: options.lastDreamAt, lastRunId: "run-0" })}\n`)
  }
  let runCounter = 0
  const store = new ReflectionReservationStore({
    identity,
    config: {},
    getJournal: async (conversationId) => {
      throw new Error(`unexpected journal access: ${conversationId}`)
    },
    createRunId: () => `run-${++runCounter}`,
  })
  const launches: ReservedRun[] = []
  const session: DreamTriggerSession = {
    conversationId: CONVERSATION,
    identity: identity.id,
    identityPaths: identity.paths,
    getJournal: async (conversationId) =>
      new TranscriptJournal({ journalDir: join(identity.paths.transcripts, conversationId) }),
    store: options.reservationStore ?? store,
    launch: (run) => launches.push(run),
  }
  const idleState = { isIdle: true, hasPending: false }
  const eventCtx = {
    sessionManager: { getSessionId: () => CONVERSATION },
    isIdle: () => idleState.isIdle,
    hasPendingMessages: () => idleState.hasPending,
  }
  const scheduler = new FakeScheduler()
  const wiring = createDreamTriggerWiring({
    resolveSession: () => session,
    resolveActiveSession: () => session,
    resolveSessionById: (sessionId) => (sessionId === CONVERSATION ? session : undefined),
    resolveSettings: () => triggerSettings(options.settings),
    now: () => NOW_MS,
    scheduler,
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  })
  const pi = new FakeExtensionAPI()
  wiring.register(pi)
  return { pi, scheduler, store, launches, idleState, eventCtx, wiring, identity }
}

async function writeConversation(transcriptsDir: string, conversationId: string, text: string): Promise<void> {
  const dir = join(transcriptsDir, conversationId)
  await mkdir(dir, { recursive: true })
  const entry: TranscriptEntry = {
    kind: "user",
    text,
    captured_at: "2026-08-10T11:00:00.000Z",
    source_line_id: `${conversationId}:line:0`,
    source_message_id: `${conversationId}:message:0`,
  }
  await writeFile(join(dir, "transcript.jsonl"), `${JSON.stringify(entry)}\n`)
}

async function settle(fixture: Fixture, eventCtx: unknown = fixture.eventCtx): Promise<void> {
  await fixture.pi.dispatch("agent_settled", { type: "agent_settled" }, eventCtx)
}

/** Fires the latest scheduled timer and awaits the tracked async fire path. */
async function fireTimer(fixture: Fixture): Promise<void> {
  fixture.scheduler.latest().fire()
  await fixture.wiring.whenIdle()
}

function gateProbe(input: { readonly lastDreamAtMs?: number | null; readonly unreflectedBytes?: number } = {}): {
  readonly probe: DreamGateProbe
  readonly calls: { lastDreamAt: number; unreflectedBytes: number }
} {
  const calls = { lastDreamAt: 0, unreflectedBytes: 0 }
  return {
    calls,
    probe: {
      nowMs: NOW_MS,
      lastDreamAtMs: async () => {
        calls.lastDreamAt += 1
        return input.lastDreamAtMs === undefined ? null : input.lastDreamAtMs
      },
      unreflectedBytes: async () => {
        calls.unreflectedBytes += 1
        return input.unreflectedBytes === undefined ? DREAM_VOLUME_GATE_BYTES + 1 : input.unreflectedBytes
      },
    },
  }
}

const noopSteps: ShutdownDrainSteps = {
  flushJournal: async () => {},
  enqueueFinalDelta: async () => {},
  flushSkillsUsage: async () => {},
  launchFacts: async () => {},
}

describe("resolveDreamTriggerSettings", () => {
  test("#given base dream settings #when no agent override exists #then the base values resolve", () => {
    const resolved = resolveDreamTriggerSettings(memorySettings(), "agent-test")
    expect(resolved).toEqual({
      enabled: true,
      idleMinutes: 30,
      minHoursBetween: 24,
      shutdownLaunch: true,
      autoSelectMax: 5,
      autoSelectMaxChars: 150000,
    })
  })

  test("#given a per-agent dream override #when resolving #then overridden fields win and the rest inherit", () => {
    const settings = memorySettings()
    settings.agents["agent-test"] = { dream: { enabled: false, idle_minutes: 5 } }
    const resolved = resolveDreamTriggerSettings(settings, "agent-test")
    expect(resolved.enabled).toBe(false)
    expect(resolved.idleMinutes).toBe(5)
    expect(resolved.minHoursBetween).toBe(24)
    expect(resolved.shutdownLaunch).toBe(true)
    expect(resolved.autoSelectMax).toBe(5)
    expect(resolved.autoSelectMaxChars).toBe(150000)
  })
})

describe("evaluateDreamGates", () => {
  test("#given every gate failing #when the origin is manual #then the gates are bypassed without probing", async () => {
    const { probe, calls } = gateProbe({ lastDreamAtMs: NOW_MS, unreflectedBytes: 0 })
    const decision = await evaluateDreamGates("manual", triggerSettings({ enabled: false, shutdownLaunch: false }), probe)
    expect(decision).toEqual({ allowed: true })
    expect(calls).toEqual({ lastDreamAt: 0, unreflectedBytes: 0 })
  })

  test("#given dream disabled #when an idle origin evaluates #then it is rejected before probing", async () => {
    const { probe, calls } = gateProbe()
    const decision = await evaluateDreamGates("idle", triggerSettings({ enabled: false }), probe)
    expect(decision).toEqual({ allowed: false, rejection: "disabled" })
    expect(calls).toEqual({ lastDreamAt: 0, unreflectedBytes: 0 })
  })

  test("#given shutdown_launch disabled #when a shutdown origin evaluates #then it is rejected before probing", async () => {
    const { probe, calls } = gateProbe()
    const decision = await evaluateDreamGates("shutdown", triggerSettings({ shutdownLaunch: false }), probe)
    expect(decision).toEqual({ allowed: false, rejection: "shutdown_disabled" })
    expect(calls).toEqual({ lastDreamAt: 0, unreflectedBytes: 0 })
  })

  test("#given the last dream exactly min_hours_between ago #when an idle origin evaluates #then the spacing gate rejects without a volume probe", async () => {
    const { probe, calls } = gateProbe({ lastDreamAtMs: NOW_MS - 24 * 3_600_000 })
    const decision = await evaluateDreamGates("idle", triggerSettings(), probe)
    expect(decision).toEqual({ allowed: false, rejection: "too_soon" })
    expect(calls).toEqual({ lastDreamAt: 1, unreflectedBytes: 0 })
  })

  test("#given the last dream one millisecond past min_hours_between #when an idle origin evaluates #then it is allowed", async () => {
    const { probe } = gateProbe({ lastDreamAtMs: NOW_MS - 24 * 3_600_000 - 1 })
    const decision = await evaluateDreamGates("idle", triggerSettings(), probe)
    expect(decision).toEqual({ allowed: true })
  })

  test("#given no recorded dream #when an idle origin evaluates #then the spacing gate passes", async () => {
    const { probe } = gateProbe({ lastDreamAtMs: null })
    const decision = await evaluateDreamGates("idle", triggerSettings(), probe)
    expect(decision).toEqual({ allowed: true })
  })

  test("#given unreflected volume exactly at the floor #when an idle origin evaluates #then the volume gate rejects", async () => {
    const { probe } = gateProbe({ unreflectedBytes: DREAM_VOLUME_GATE_BYTES })
    const decision = await evaluateDreamGates("idle", triggerSettings(), probe)
    expect(decision).toEqual({ allowed: false, rejection: "insufficient_volume" })
  })

  test("#given unreflected volume one byte above the floor #when a shutdown origin evaluates #then it is allowed", async () => {
    const { probe } = gateProbe({ unreflectedBytes: DREAM_VOLUME_GATE_BYTES + 1 })
    const decision = await evaluateDreamGates("shutdown", triggerSettings(), probe)
    expect(decision).toEqual({ allowed: true })
  })
})

describe("dream idle timer matrix", () => {
  test("#given a settled agent #when the settle event arrives #then an idle timer is armed for idle_minutes", async () => {
    const f = await fixture()
    await settle(f)
    expect(f.scheduler.scheduled).toHaveLength(1)
    expect(f.scheduler.latest().delayMs).toBe(IDLE_MS)
  })

  test("#given an armed idle timer #when the agent settles again #then the first timer is cancelled and a fresh one armed", async () => {
    const f = await fixture()
    await settle(f)
    const first = f.scheduler.latest()
    await settle(f)
    expect(first.cancelled).toBe(true)
    expect(f.scheduler.scheduled).toHaveLength(2)
    expect(f.scheduler.latest().cancelled).toBe(false)
  })

  test("#given an armed idle timer #when an input event arrives #then the timer resets and the next settle re-arms", async () => {
    const f = await fixture()
    await settle(f)
    const armed = f.scheduler.latest()
    await f.pi.dispatch("input", { type: "input" }, f.eventCtx)
    expect(armed.cancelled).toBe(true)
    armed.fire()
    await f.wiring.whenIdle()
    expect(f.launches).toHaveLength(0)
    await settle(f)
    expect(f.scheduler.scheduled).toHaveLength(2)
    await fireTimer(f)
    expect(f.launches).toHaveLength(1)
    expect(f.launches[0]?.request.origin).toBe("idle")
  })

  test("#given an armed idle timer #when an agent_start event arrives #then the timer resets and the next settle re-arms", async () => {
    const f = await fixture()
    await settle(f)
    const armed = f.scheduler.latest()
    await f.pi.dispatch("agent_start", { type: "agent_start" }, f.eventCtx)
    expect(armed.cancelled).toBe(true)
    armed.fire()
    await f.wiring.whenIdle()
    expect(f.launches).toHaveLength(0)
    await settle(f)
    await fireTimer(f)
    expect(f.launches).toHaveLength(1)
  })

  test("#given an armed idle timer #when a session_compact event arrives #then the timer resets and the next settle re-arms", async () => {
    const f = await fixture()
    await settle(f)
    const armed = f.scheduler.latest()
    await f.pi.dispatch("session_compact", { type: "session_compact" }, f.eventCtx)
    expect(armed.cancelled).toBe(true)
    armed.fire()
    await f.wiring.whenIdle()
    expect(f.launches).toHaveLength(0)
    await settle(f)
    await fireTimer(f)
    expect(f.launches).toHaveLength(1)
  })

  test("#given an armed idle timer #when the session shuts down #then the timer is cancelled and a stale fire launches nothing", async () => {
    const f = await fixture()
    await settle(f)
    const armed = f.scheduler.latest()
    await f.pi.dispatch("session_shutdown", { type: "session_shutdown" }, f.eventCtx)
    expect(armed.cancelled).toBe(true)
    armed.fire()
    await f.wiring.whenIdle()
    expect(f.launches).toHaveLength(0)
    expect(await f.store.readState()).toEqual({})
  })

  test("#given an armed idle timer #when the session aborts #then the timer is cancelled and a stale fire launches nothing", async () => {
    const f = await fixture()
    await settle(f)
    const armed = f.scheduler.latest()
    await f.pi.dispatch("session_abort", { type: "session_abort" }, f.eventCtx)
    expect(armed.cancelled).toBe(true)
    armed.fire()
    await f.wiring.whenIdle()
    expect(f.launches).toHaveLength(0)
    expect(await f.store.readState()).toEqual({})
  })

  test("#given idle_minutes zero #when the agent settles #then no timer is armed", async () => {
    const f = await fixture({ settings: { idleMinutes: 0 } })
    await settle(f)
    expect(f.scheduler.scheduled).toHaveLength(0)
  })

  test("#given an armed idle timer #when it fires while the agent is streaming #then no dream is requested", async () => {
    const f = await fixture()
    await settle(f)
    f.idleState.isIdle = false
    await fireTimer(f)
    expect(f.launches).toHaveLength(0)
    expect(await f.store.readState()).toEqual({})
  })

  test("#given an armed idle timer #when it fires with pending messages #then no dream is requested", async () => {
    const f = await fixture()
    await settle(f)
    f.idleState.hasPending = true
    await fireTimer(f)
    expect(f.launches).toHaveLength(0)
    expect(await f.store.readState()).toEqual({})
  })

  test("#given a timer armed from a context without idle probes #when it fires #then no dream is requested", async () => {
    const f = await fixture()
    await settle(f, {})
    await fireTimer(f)
    expect(f.launches).toHaveLength(0)
    expect(await f.store.readState()).toEqual({})
  })
})

describe("automatic dream gates", () => {
  test("#given dream disabled #when the idle timer fires #then no reservation is made", async () => {
    const f = await fixture({ settings: { enabled: false } })
    await settle(f)
    await fireTimer(f)
    expect(f.launches).toHaveLength(0)
    expect(await f.store.readState()).toEqual({})
  })

  test("#given a dream one hour ago #when the idle timer fires #then the spacing gate blocks the launch", async () => {
    const f = await fixture({ lastDreamAt: new Date(NOW_MS - 3_600_000).toISOString() })
    await settle(f)
    await fireTimer(f)
    expect(f.launches).toHaveLength(0)
    expect(await f.store.readState()).toEqual({})
  })

  test("#given unreflected volume exactly at the floor #when the idle timer fires #then the volume gate blocks the launch", async () => {
    const f = await fixture({ conversationText: "x".repeat(DREAM_VOLUME_GATE_BYTES) })
    await settle(f)
    await fireTimer(f)
    expect(f.launches).toHaveLength(0)
    expect(await f.store.readState()).toEqual({})
  })

  test("#given every gate passing #when the idle timer fires #then a dream run is reserved and launched", async () => {
    const f = await fixture({ conversationText: "x".repeat(DREAM_VOLUME_GATE_BYTES + 1) })
    await settle(f)
    await fireTimer(f)
    expect(f.launches).toHaveLength(1)
    expect(f.launches[0]?.request.trigger).toBe("dream")
    expect(f.launches[0]?.request.origin).toBe("idle")
    expect(f.launches[0]?.request.conversationIds).toEqual([CONVERSATION])
    expect(f.launches[0]?.request.snapshots).toHaveLength(1)
    const state = await f.store.readState()
    expect(state.active?.request.trigger).toBe("dream")
  })
})

describe("dream shutdown evaluator", () => {
  test("#given every gate passing #when a quit drains through the registered evaluator #then a shutdown dream launches", async () => {
    const f = await fixture()
    const drain = createShutdownDrain({ steps: noopSteps })
    drain.registerEvaluator(f.wiring.shutdownEvaluator())
    await drain.run({ reason: "quit", sessionId: CONVERSATION, deadlineAt: NOW_MS + 1500, now: () => NOW_MS })
    expect(f.launches).toHaveLength(1)
    expect(f.launches[0]?.request.trigger).toBe("dream")
    expect(f.launches[0]?.request.origin).toBe("shutdown")
  })

  test("#given every gate passing #when a non-quit shutdown drains #then the evaluator never runs", async () => {
    const f = await fixture()
    const drain = createShutdownDrain({ steps: noopSteps })
    drain.registerEvaluator(f.wiring.shutdownEvaluator())
    await drain.run({ reason: "reload", sessionId: CONVERSATION, deadlineAt: NOW_MS + 1500, now: () => NOW_MS })
    expect(f.launches).toHaveLength(0)
    expect(await f.store.readState()).toEqual({})
  })

  test("#given shutdown_launch disabled #when the evaluator runs #then no reservation is made", async () => {
    const f = await fixture({ settings: { shutdownLaunch: false } })
    await f.wiring.shutdownEvaluator()({
      reason: "quit",
      sessionId: CONVERSATION,
      deadlineAt: NOW_MS + 1500,
      signal: new AbortController().signal,
    })
    expect(f.launches).toHaveLength(0)
    expect(await f.store.readState()).toEqual({})
  })

  test("#given a dream one hour ago #when the evaluator runs #then the spacing gate blocks the launch", async () => {
    const f = await fixture({ lastDreamAt: new Date(NOW_MS - 3_600_000).toISOString() })
    await f.wiring.shutdownEvaluator()({
      reason: "quit",
      sessionId: CONVERSATION,
      deadlineAt: NOW_MS + 1500,
      signal: new AbortController().signal,
    })
    expect(f.launches).toHaveLength(0)
    expect(await f.store.readState()).toEqual({})
  })

  test("#given a pre-aborted drain signal #when the evaluator runs #then no reservation is made", async () => {
    const f = await fixture()
    const controller = new AbortController()
    controller.abort()
    await f.wiring.shutdownEvaluator()({
      reason: "quit",
      sessionId: CONVERSATION,
      deadlineAt: NOW_MS + 1500,
      signal: controller.signal,
    })
    expect(f.launches).toHaveLength(0)
    expect(await f.store.readState()).toEqual({})
  })

  test("#given abort arrives while shutdown reservation is in flight #when the reservation returns active #then no dream child launch starts", async () => {
    let releaseReservation: (() => void) | undefined
    const reservationReleased = new Promise<void>((resolve) => { releaseReservation = resolve })
    let signalReservationStarted: (() => void) | undefined
    const reservationStarted = new Promise<void>((resolve) => { signalReservationStarted = resolve })
    let reserve: DreamTriggerSession["store"]["tryReserve"] | undefined
    const f = await fixture({
      reservationStore: {
        tryReserve: async (request) => {
          signalReservationStarted?.()
          await reservationReleased
          if (reserve === undefined) throw new Error("reservation delegate unavailable")
          return reserve(request)
        },
      },
    })
    reserve = f.store.tryReserve.bind(f.store)
    const controller = new AbortController()
    const evaluating = f.wiring.shutdownEvaluator()({
      reason: "quit",
      sessionId: CONVERSATION,
      deadlineAt: NOW_MS + 1500,
      signal: controller.signal,
    })
    await Promise.race([
      reservationStarted,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("shutdown reservation did not start")), 2_000)),
    ])

    controller.abort()
    releaseReservation?.()
    await evaluating

    expect(f.launches).toHaveLength(0)
  })
})

describe("manual dream origin", () => {
  test("#given a fresh sub-floor transcript and a recent dream #when a manual dream is requested #then it launches past every gate", async () => {
    const f = await fixture({
      conversationText: "hello memory",
      lastDreamAt: new Date(NOW_MS - 3_600_000).toISOString(),
    })
    const outcome = await f.wiring.requestManualDream()
    expect(outcome).toEqual({ fired: true, runId: "run-1", status: "active" })
    expect(f.launches).toHaveLength(1)
    expect(f.launches[0]?.request.trigger).toBe("dream")
    expect(f.launches[0]?.request.origin).toBe("manual")
    expect(f.launches[0]?.request.conversationIds).toEqual([CONVERSATION])
  })

  test("#given dream disabled #when a manual dream is requested #then it still launches", async () => {
    const f = await fixture({ settings: { enabled: false } })
    const outcome = await f.wiring.requestManualDream()
    expect(outcome.fired).toBe(true)
    expect(f.launches[0]?.request.origin).toBe("manual")
  })

  test("#given explicit conversation ids #when a manual dream is requested #then those conversations are reserved", async () => {
    const f = await fixture({ conversationText: null })
    await writeConversation(f.identity.paths.transcripts, "conversation-b", "second conversation")
    const outcome = await f.wiring.requestManualDream({
      conversationIds: ["conversation-b"],
      targetDoc: "reference/style.md",
    })
    expect(outcome).toEqual({ fired: true, runId: "run-1", status: "active" })
    expect(f.launches[0]?.request.conversationIds).toEqual(["conversation-b"])
    expect(f.launches[0]?.request.snapshots).toHaveLength(1)
    expect(f.launches[0]?.request.targetDoc).toBe("reference/style.md")
  })

  test("#given no unreflected content anywhere #when a manual dream is requested #then it declines to reserve", async () => {
    const f = await fixture({ conversationText: null })
    const outcome = await f.wiring.requestManualDream()
    expect(outcome).toEqual({ fired: false, rejection: "no_unreflected_content" })
    expect(f.launches).toHaveLength(0)
    expect(await f.store.readState()).toEqual({})
  })
})

describe("dream reservation integration", () => {
  test("#given an active reflection run #when the idle timer fires #then the dream queues as pending and does not launch", async () => {
    const f = await fixture()
    await f.store.tryReserve({ trigger: "manual", conversationIds: ["other"], snapshots: [] })
    await settle(f)
    await fireTimer(f)
    expect(f.launches).toHaveLength(0)
    const state = await f.store.readState()
    expect(state.active?.request.trigger).toBe("manual")
    expect(state.pending?.request.trigger).toBe("dream")
    expect(state.pending?.request.origin).toBe("idle")
  })
})
