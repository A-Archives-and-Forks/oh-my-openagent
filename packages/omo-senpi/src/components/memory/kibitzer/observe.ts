// Durable, bounded observability and retention of the resident Kibitzer.
//
// `recall/sidecars/<encoded-session>/` is one main session's audit directory: the child's own
// session JSONL (senpi writes it there because the ChildSpec's `sessionDir` points at it) plus
// `wakes.ndjson`, one line per settled wake. Every line is a closed record - status, cause, model,
// cursor span, tool calls, duration, provider usage, delivered paths - bounded field by field and
// then as a whole, with the failure reason masked (memory-core and senpi secret patterns) and cut
// before any stack frame, so nothing a provider or a child error said verbatim reaches disk.
//
// The `omo-kibitzer:gate` notice moves here from the one-shot gate wiring with its policy intact:
// an isolated failure is silent (the ndjson line is its only trace); the third consecutive
// diagnostic failure of one main session appends exactly one actionable notice; a normal
// completion or the session's shutdown resets the streak.
//
// Retention: a sidecar directory idle for seven days is removed - never while a session owns it.
// Ownership is an ordinary memory-core lock (`locks/recall-sidecar.<encoded-session>.lock`) held
// from sidecar creation to session shutdown, so a sweep from another process sees a live owner
// (contention) and skips, while a crashed owner is recovered only on pid/start-identity proof, as
// every other lock domain does. This process's own live sessions are skipped before any lock is
// touched. The sweep runs once per identity when its first sidecar comes alive and again at every
// session shutdown; a directory is claimed by rename under its owner lock and deleted afterwards,
// and a tombstone left by a crash is cleared by the next sweep.

import { randomUUID } from "node:crypto"
import { basename, dirname, join } from "node:path"

import { LockContentionError, acquireLock, createLockRecord, releaseLock, type LockRecord } from "@oh-my-opencode/memory-core"
import { appendFile, lstat, mkdir, readdir, rename, rm } from "@oh-my-opencode/memory-core/fs"

import type { ComponentLogger } from "../../../extension/types"
import type { MemoryIdentityContext } from "../context"
import { redactKibitzerEventText } from "./events"
import { normalizeGateReason } from "./judge-outcome"
import { GATE_ENTRY_TYPE, type KibitzerGateRecord } from "./notice"
import type { KibitzerWakeOutcome, KibitzerWakeStatus, KibitzerWakeUsage } from "./sidecar-outcome"

export const KIBITZER_WAKES_FILENAME = "wakes.ndjson"
/** A sidecar directory idle this long is removed by the next sweep, unless a session still owns it. */
export const KIBITZER_SIDECAR_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
/** Consecutive diagnostic failures of one main session before the single actionable notice. */
export const KIBITZER_PERSISTENT_FAILURE_THRESHOLD = 3
/** Hard bound of one serialized `wakes.ndjson` line, newline included. */
export const KIBITZER_WAKE_RECORD_MAX_CHARS = 4096
const WAKE_MODEL_MAX_CHARS = 128
const WAKE_PATH_MAX_CHARS = 256
const SIDECARS_DIRNAME = "sidecars"
const OWNER_LOCK_PREFIX = "recall-sidecar."
const OWNER_LOCK_SUFFIX = ".lock"
const OWNER_LOCK_PURPOSE = "recall-sidecar"
const PRUNE_TOMBSTONE_PREFIX = ".prune-"
/** How long a sidecar coming alive waits for its owner lock: long enough to outlast a sweep's claim. */
const OWNER_LOCK_WAIT_MS = 2_000
const ENCODED_SESSION_PATTERN = /^[A-Za-z0-9_-]+$/

// ---- directory identity ----------------------------------------------------------------------------

/** Unpadded URL-safe base64 of the id's UTF-8 bytes: injective, and every output is a safe path segment. */
export function encodeKibitzerSessionId(sessionId: string): string {
  return Buffer.from(sessionId, "utf8").toString("base64url")
}

/** The exact parent session id behind a sidecar directory name, or undefined for a name this module never produced. */
export function decodeKibitzerSidecarDirName(name: string): string | undefined {
  if (!ENCODED_SESSION_PATTERN.test(name)) return undefined
  const bytes = Buffer.from(name, "base64url")
  return bytes.toString("base64url") === name ? bytes.toString("utf8") : undefined
}

export function kibitzerSidecarsRoot(recallDir: string): string {
  return join(recallDir, SIDECARS_DIRNAME)
}

/**
 * `recall/sidecars/<encoded-session>/`: URL-safe base64 of the parent session id's UTF-8 bytes,
 * unpadded, so distinct ids never share a directory and any id is a safe path segment.
 */
export function kibitzerSidecarSessionDir(recallDir: string, sessionId: string): string {
  return join(kibitzerSidecarsRoot(recallDir), encodeKibitzerSessionId(sessionId))
}

export function kibitzerWakesFile(recallDir: string, sessionId: string): string {
  return join(kibitzerSidecarSessionDir(recallDir, sessionId), KIBITZER_WAKES_FILENAME)
}

/** The lock a live session holds over its sidecar directory, under the identity's `runtime/locks`. */
export function kibitzerSidecarOwnerLockPath(locksDir: string, sessionId: string): string {
  return ownerLockPathFor(locksDir, encodeKibitzerSessionId(sessionId))
}

function ownerLockPathFor(locksDir: string, encodedSession: string): string {
  return join(locksDir, `${OWNER_LOCK_PREFIX}${encodedSession}${OWNER_LOCK_SUFFIX}`)
}

// ---- the wake record -------------------------------------------------------------------------------

/** One line of `wakes.ndjson`. Every string is bounded and masked; the whole line is bounded again. */
export interface KibitzerWakeRecord {
  readonly version: 1
  /** ISO timestamp of the settlement. */
  readonly at: string
  readonly sessionId: string
  readonly wake: number
  readonly generation: number
  readonly status: KibitzerWakeStatus
  readonly cause?: string
  /** Masked, frame-free, at most `GATE_REASON_MAX_CHARS`. */
  readonly reason?: string
  readonly model?: string
  readonly candidateCount: number
  /** Paths of the nudges the parent re-validated and handed to delivery. */
  readonly nudged: readonly string[]
  readonly steered: number
  readonly toolCalls: number
  readonly durationMs: number
  readonly slotWaitMs: number
  readonly cursors?: { readonly first: number; readonly last: number }
  readonly contextTokens?: number
  readonly usage?: KibitzerWakeUsage
  readonly diagnostic: boolean
  /** Present only when the record had to drop its paths and reason to fit the line bound. */
  readonly truncated?: true
}

/**
 * The failure reason as it may be written: cut before the first stack frame (a frame names local
 * paths and code), masked by both secret vocabularies, then bounded like a gate reason.
 */
export function redactKibitzerWakeReason(reason: string | undefined): string | undefined {
  if (reason === undefined) return undefined
  const head = reason.split(/\r?\n\s*at\s+/u, 1)[0] ?? ""
  return normalizeGateReason(redactKibitzerEventText(head))
}

export function kibitzerWakeRecord(outcome: KibitzerWakeOutcome, at: number): KibitzerWakeRecord {
  const reason = redactKibitzerWakeReason(outcome.reason)
  const record: KibitzerWakeRecord = {
    version: 1,
    at: new Date(at).toISOString(),
    sessionId: outcome.sessionId,
    wake: outcome.wake,
    generation: outcome.generation,
    status: outcome.status,
    ...(outcome.cause === undefined ? {} : { cause: outcome.cause }),
    ...(reason === undefined ? {} : { reason }),
    ...(outcome.model === undefined ? {} : { model: capped(redactKibitzerEventText(outcome.model), WAKE_MODEL_MAX_CHARS) }),
    candidateCount: outcome.candidateCount,
    nudged: outcome.nudges.map((nudge) => capped(nudge.path, WAKE_PATH_MAX_CHARS)),
    steered: outcome.steered,
    toolCalls: outcome.toolCalls,
    durationMs: outcome.durationMs,
    slotWaitMs: outcome.slotWaitMs,
    ...(outcome.cursors === undefined ? {} : { cursors: { first: outcome.cursors.first, last: outcome.cursors.last } }),
    ...(outcome.contextTokens === undefined ? {} : { contextTokens: outcome.contextTokens }),
    ...(outcome.usage === undefined ? {} : { usage: { ...outcome.usage } }),
    diagnostic: outcome.diagnostic,
  }
  if (JSON.stringify(record).length < KIBITZER_WAKE_RECORD_MAX_CHARS) return record
  const { reason: _reason, ...bounded } = record
  return { ...bounded, nudged: [], truncated: true }
}

function capped(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max)
}

// ---- the observability instance -----------------------------------------------------------------

export interface KibitzerObservabilityOptions {
  /** The main session's entry sink; the gate notice is the only entry this module appends. */
  readonly appendEntry: (customType: string, data?: unknown) => void
  readonly now?: () => number
  readonly retentionMs?: number
  readonly logger?: ComponentLogger
}

export interface KibitzerObservability {
  /** A session's sidecar exists from now on: its directory is owned - never pruned - until shutdown. */
  own(sessionId: string, context: MemoryIdentityContext): void
  /** One settled wake: one ndjson line, then the diagnostic streak. Synchronous, never throws. */
  onWake(outcome: KibitzerWakeOutcome, context: MemoryIdentityContext): void
  /**
   * Makes the session's queued records durable, releases its directory, forgets its streak and
   * sweeps the identity's aged sidecar directories (detached; `whenIdle` covers it).
   */
  onSessionShutdown(sessionId: string, context: MemoryIdentityContext): Promise<void>
  /** Resolves once every queued write, lock transition and sweep has ended. */
  whenIdle(): Promise<void>
}

interface Ownership {
  readonly encoded: string
  readonly lockPath: string
  /** The record the lock was published with; undefined when the lock could not be taken. */
  readonly lock: Promise<LockRecord | undefined>
}

interface Streak {
  count: number
  notified: boolean
}

export function createKibitzerObservability(options: KibitzerObservabilityOptions): KibitzerObservability {
  const now = options.now ?? Date.now
  const retentionMs = options.retentionMs ?? KIBITZER_SIDECAR_RETENTION_MS
  const owned = new Map<string, Ownership>()
  const streaks = new Map<string, Streak>()
  /** Per-session write chains: one file, one writer, lines in wake order. */
  const writers = new Map<string, Promise<void>>()
  const sweeping = new Map<string, Promise<void>>()
  const sweptOnce = new Set<string>()
  const inFlight = new Set<Promise<unknown>>()

  function warn(message: string, details: Record<string, unknown>): void {
    options.logger?.warn(message, details)
  }

  function track<T>(promise: Promise<T>): Promise<T> {
    const tracked: Promise<T> = promise.finally(() => inFlight.delete(tracked))
    inFlight.add(tracked)
    return tracked
  }

  // ---- ownership -----------------------------------------------------------------------------------

  async function takeOwnerLock(lockPath: string, sessionId: string): Promise<LockRecord | undefined> {
    try {
      const record = await createLockRecord(OWNER_LOCK_PURPOSE)
      await acquireLock(lockPath, record, { waitTimeoutMs: OWNER_LOCK_WAIT_MS })
      return record
    } catch (error) {
      warn("omo-senpi kibitzer sidecar directory owner lock unavailable", { sessionId, lockPath, error: describe(error) })
      return undefined
    }
  }

  function own(sessionId: string, context: MemoryIdentityContext): void {
    if (owned.has(sessionId)) return
    const encoded = encodeKibitzerSessionId(sessionId)
    const lockPath = ownerLockPathFor(context.identityPaths.locks, encoded)
    owned.set(sessionId, { encoded, lockPath, lock: track(takeOwnerLock(lockPath, sessionId)) })
    const recallDir = context.identityPaths.recall
    if (sweptOnce.has(recallDir)) return
    sweptOnce.add(recallDir)
    sweep(context)
  }

  async function disown(sessionId: string): Promise<void> {
    const ownership = owned.get(sessionId)
    if (ownership === undefined) return
    owned.delete(sessionId)
    const record = await ownership.lock
    if (record === undefined) return
    try {
      await releaseLock(ownership.lockPath, record)
    } catch (error) {
      warn("omo-senpi kibitzer sidecar directory owner lock release failed", { sessionId, lockPath: ownership.lockPath, error: describe(error) })
    }
  }

  // ---- the wake record -----------------------------------------------------------------------------

  async function appendWake(context: MemoryIdentityContext, sessionId: string, line: string): Promise<void> {
    const file = kibitzerWakesFile(context.identityPaths.recall, sessionId)
    try {
      await mkdir(kibitzerSidecarSessionDir(context.identityPaths.recall, sessionId), { recursive: true, mode: 0o700 })
      await appendFile(file, line, { encoding: "utf8", mode: 0o600 })
    } catch (error) {
      warn("omo-senpi kibitzer wake record write failed", { sessionId, file, error: describe(error) })
    }
  }

  function onWake(outcome: KibitzerWakeOutcome, context: MemoryIdentityContext): void {
    const line = `${JSON.stringify(kibitzerWakeRecord(outcome, now()))}\n`
    const previous = writers.get(outcome.sessionId) ?? Promise.resolve()
    const next = track(previous.then(() => appendWake(context, outcome.sessionId, line)))
    writers.set(outcome.sessionId, next)
    void next.finally(() => {
      if (writers.get(outcome.sessionId) === next) writers.delete(outcome.sessionId)
    })
    observeStreak(outcome)
  }

  // ---- the diagnostic streak -----------------------------------------------------------------------

  function observeStreak(outcome: KibitzerWakeOutcome): void {
    if (!outcome.diagnostic) {
      streaks.delete(outcome.sessionId)
      return
    }
    const streak = streaks.get(outcome.sessionId) ?? { count: 0, notified: false }
    streak.count += 1
    streaks.set(outcome.sessionId, streak)
    if (streak.count < KIBITZER_PERSISTENT_FAILURE_THRESHOLD || streak.notified) return
    streak.notified = true
    const reason = redactKibitzerWakeReason(outcome.reason)
    const record: KibitzerGateRecord = {
      version: 1,
      status: "failed",
      cause: outcome.cause ?? "child_failed",
      ...(outcome.model === undefined ? {} : { model: capped(redactKibitzerEventText(outcome.model), WAKE_MODEL_MAX_CHARS) }),
      candidateCount: outcome.candidateCount,
      ...(reason === undefined ? {} : { reason }),
      consecutiveFailures: streak.count,
      wake: outcome.wake,
    }
    try {
      options.appendEntry(GATE_ENTRY_TYPE, record)
    } catch (error) {
      warn("omo-senpi kibitzer gate notice append failed", { sessionId: outcome.sessionId, error: describe(error) })
    }
  }

  // ---- retention -----------------------------------------------------------------------------------

  function sweep(context: MemoryIdentityContext): void {
    const recallDir = context.identityPaths.recall
    if (sweeping.has(recallDir)) return
    const run = track(pruneKibitzerSidecars({
      recallDir,
      locksDir: context.identityPaths.locks,
      now,
      maxAgeMs: retentionMs,
      owned: new Set([...owned.values()].map((ownership) => ownership.encoded)),
      warn,
    }).then(() => undefined, (error: unknown) => {
      warn("omo-senpi kibitzer sidecar sweep failed", { recallDir, error: describe(error) })
    }).finally(() => {
      sweeping.delete(recallDir)
    }))
    sweeping.set(recallDir, run)
  }

  return {
    own,
    onWake,
    async onSessionShutdown(sessionId, context): Promise<void> {
      streaks.delete(sessionId)
      await (writers.get(sessionId) ?? Promise.resolve())
      await disown(sessionId)
      sweep(context)
    },
    async whenIdle(): Promise<void> {
      while (inFlight.size > 0) await Promise.allSettled([...inFlight])
    },
  }
}

// ---- the sweep -------------------------------------------------------------------------------------

export interface PruneKibitzerSidecarsOptions {
  readonly recallDir: string
  readonly locksDir: string
  readonly now?: () => number
  readonly maxAgeMs?: number
  /** Encoded directory names of this process's live sessions: skipped before any lock is touched. */
  readonly owned?: ReadonlySet<string>
  readonly warn?: (message: string, details: Record<string, unknown>) => void
}

export interface PruneKibitzerSidecarsResult {
  /** Encoded directory names removed. */
  readonly pruned: readonly string[]
  /** Encoded directory names inspected and left in place. */
  readonly kept: readonly string[]
}

/**
 * Removes every sidecar directory idle for `maxAgeMs`, except one owned by a live session: this
 * process's own sessions by name, any process's by its owner lock (contention means live; a dead
 * owner is recovered only on proof). The idle check is repeated under the lock so a session that
 * came alive during the scan keeps its directory. Anything that is not a directory is ignored.
 */
export async function pruneKibitzerSidecars(options: PruneKibitzerSidecarsOptions): Promise<PruneKibitzerSidecarsResult> {
  const now = options.now ?? Date.now
  const maxAgeMs = options.maxAgeMs ?? KIBITZER_SIDECAR_RETENTION_MS
  const owned = options.owned ?? new Set<string>()
  const root = kibitzerSidecarsRoot(options.recallDir)
  const names = await readdir(root).catch((error: unknown) => {
    if (errorCode(error) !== "ENOENT") options.warn?.("omo-senpi kibitzer sidecar sweep listing failed", { path: root, error: describe(error) })
    return [] as string[]
  })
  const pruned: string[] = []
  const kept: string[] = []
  for (const name of names) {
    const path = join(root, name)
    if (name.startsWith(PRUNE_TOMBSTONE_PREFIX)) {
      await remove(path, options.warn)
      continue
    }
    if (owned.has(name) || !ENCODED_SESSION_PATTERN.test(name)) {
      if (owned.has(name)) kept.push(name)
      continue
    }
    const stats = await lstat(path).catch(() => undefined)
    if (stats === undefined || !stats.isDirectory()) continue
    if (!(await idleFor(path, now(), maxAgeMs))) {
      kept.push(name)
      continue
    }
    if (await claimAndRemove(path, ownerLockPathFor(options.locksDir, name), now(), maxAgeMs, options.warn)) pruned.push(name)
    else kept.push(name)
  }
  return { pruned, kept }
}

/** True when neither the directory nor anything directly inside it changed within `maxAgeMs`. */
async function idleFor(dir: string, at: number, maxAgeMs: number): Promise<boolean> {
  const newest = await newestMtime(dir)
  return newest !== undefined && at - newest >= maxAgeMs
}

async function newestMtime(dir: string): Promise<number | undefined> {
  const own = await lstat(dir).then((stats) => stats.mtimeMs, () => undefined)
  if (own === undefined) return undefined
  let newest = own
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const stamp = await lstat(join(dir, name)).then((stats) => stats.mtimeMs, () => undefined)
    if (stamp !== undefined && stamp > newest) newest = stamp
  }
  return newest
}

/** Takes the directory's owner lock without waiting; a live owner keeps it, a dead one is recovered on proof. */
async function claimAndRemove(
  dir: string,
  lockPath: string,
  at: number,
  maxAgeMs: number,
  warn: PruneKibitzerSidecarsOptions["warn"],
): Promise<boolean> {
  let record: LockRecord
  try {
    record = await createLockRecord(OWNER_LOCK_PURPOSE)
    await acquireLock(lockPath, record, { waitTimeoutMs: 0 })
  } catch (error) {
    if (!(error instanceof LockContentionError)) warn?.("omo-senpi kibitzer sidecar sweep lock failed", { lockPath, error: describe(error) })
    return false
  }
  try {
    // A session that came alive between the scan and the lock has written since: leave it alone.
    if (!(await idleFor(dir, at, maxAgeMs))) return false
    const tombstone = join(dirname(dir), `${PRUNE_TOMBSTONE_PREFIX}${basename(dir)}-${randomUUID()}`)
    try {
      await rename(dir, tombstone)
    } catch (error) {
      if (errorCode(error) === "ENOENT") return false
      warn?.("omo-senpi kibitzer sidecar sweep claim failed", { path: dir, error: describe(error) })
      return false
    }
    return remove(tombstone, warn)
  } finally {
    await releaseLock(lockPath, record).catch((error: unknown) => {
      warn?.("omo-senpi kibitzer sidecar sweep lock release failed", { lockPath, error: describe(error) })
    })
  }
}

async function remove(path: string, warn: PruneKibitzerSidecarsOptions["warn"]): Promise<boolean> {
  try {
    await rm(path, { recursive: true, force: true })
    return true
  } catch (error) {
    warn?.("omo-senpi kibitzer sidecar sweep removal failed", { path, error: describe(error) })
    return false
  }
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
