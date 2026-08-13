import { randomUUID } from "node:crypto"
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises"
import { basename, join } from "node:path"

import type { EntryRenderer } from "@code-yeongyu/senpi"
import type { DreamOrigin, ReflectionOutcome, ReflectionTrigger } from "@oh-my-opencode/memory-core"
import { normalizeRendererText } from "@oh-my-opencode/senpi-task/renderer-text"

import {
  detailExcerpt,
  joinFields,
  noticeComponent,
  outcomeGlyph,
  outcomeLabel,
  outcomeSummary,
  outcomeThemeColor,
  optionalRendererText,
  runLabel,
} from "./entry-renderers"

export const REFLECTION_COMPLETION_ENTRY_TYPE = "senpi-memory.reflection-completion"
export const REFLECTION_LAUNCHED_ENTRY_TYPE = "senpi-memory.reflection-launched"
export const REFLECTION_SUMMARY_ENTRY_TYPE = "senpi-memory.reflection-summary"

const DETAILED_DRAIN_LIMIT = 5
const COMPLETION_MAX_AGE_MS = 7 * 24 * 60 * 60_000

export interface ReflectionCompletionSummary {
  readonly schemaVersion: 1
  readonly count: number
  readonly failedCount: number
  readonly oldestISO: string
  readonly newestISO: string
  readonly dominantFingerprint: string
}

export interface ReflectionLaunchedEntry {
  readonly schemaVersion: 1
  readonly runId: string
  readonly identity: string
  readonly trigger: ReflectionTrigger
  readonly category: string
  readonly model?: string
  readonly thinking?: string
  readonly conversationIds: readonly string[]
  readonly backlogSteps: number
  readonly startedAt: string
}

export interface ReflectionCompletionRecord {
  readonly schemaVersion: 1
  readonly runId: string
  readonly identity: string
  readonly category: string
  readonly model?: string
  readonly thinking?: string
  readonly conversationIds: readonly string[]
  readonly trigger: ReflectionTrigger
  readonly origin?: DreamOrigin
  readonly outcome: ReflectionOutcome
  readonly reason?: string
  readonly detail?: string
  readonly startedAt: string
  /** Palace Reflection-tab contract: ISO completion timestamp used for newest-first ordering. */
  readonly finishedAt: string
  readonly durationMs?: number
  readonly mergedCommitSha?: string
  readonly filesChanged?: number
  readonly consecutiveFailures?: number
  readonly delivery: {
    readonly status: "pending" | "consumed"
    readonly sessionId?: string
    readonly consumedAt?: string
  }
}

export interface ReflectionCompletionApi {
  appendEntry<T = unknown>(customType: string, data?: T): void
  registerEntryRenderer<T>(customType: string, renderer: EntryRenderer<T>): void
}

export interface ReflectionCompletionUi {
  notify(message: string, level: "info" | "warning" | "error"): void
}

export interface ReflectionLiveSession {
  readonly sessionId: string
  readonly api: ReflectionCompletionApi
  readonly ui?: ReflectionCompletionUi
  readonly onCompletion?: (runId: string) => void | Promise<void>
  readonly logger?: {
    warn(message: string, details?: unknown): void
  }
}

/** Plain-text launch line, kept for notify/log surfaces that cannot carry colour. */
export function reflectionLaunchedText(launched: ReflectionLaunchedEntry): string {
  return `memory reflection started run:${normalizeRendererText(launched.runId)} trigger:${normalizeRendererText(launched.trigger)} (+${launched.backlogSteps} steps)`
}

// In-flight work reads as `accent`, matching the running state in statusThemeColor.
export const renderReflectionLaunchedEntry: EntryRenderer<ReflectionLaunchedEntry> = (entry, options, theme) => {
  const launched = entry.data
  if (launched === undefined) return undefined
  return noticeComponent(
    {
      glyph: "◐",
      title: joinFields(["Memory reflection started", runLabel(launched.runId)]),
      tone: "accent",
      why: `Triggered by ${normalizeRendererText(launched.trigger)} after ${launched.backlogSteps} new step${launched.backlogSteps === 1 ? "" : "s"}.`,
      detail: joinFields([
        `category ${normalizeRendererText(launched.category)}`,
        optionalRendererText(launched.model) === undefined ? undefined : `model ${optionalRendererText(launched.model)}`,
        optionalRendererText(launched.thinking) === undefined ? undefined : `thinking ${optionalRendererText(launched.thinking)}`,
        `identity ${normalizeRendererText(launched.identity)}`,
      ]),
    },
    options,
    theme,
  )
}

export const renderReflectionCompletionEntry: EntryRenderer<ReflectionCompletionRecord> = (entry, options, theme) => {
  const record = entry.data
  if (!record) return undefined
  const reason = optionalRendererText(record.reason)
  const detail = optionalRendererText(record.detail)
  return noticeComponent(
    {
      glyph: outcomeGlyph(record.outcome),
      title: joinFields([`Memory reflection ${outcomeLabel(record.outcome)}`, runLabel(record.runId)]),
      tone: outcomeThemeColor(record.outcome),
      why: outcomeSummary(record.outcome),
      detail: joinFields([
        `category ${normalizeRendererText(record.category)}`,
        record.filesChanged === undefined ? undefined : `files ${record.filesChanged}`,
        record.mergedCommitSha === undefined ? undefined : `commit ${normalizeRendererText(record.mergedCommitSha).slice(0, 7)}`,
        record.durationMs === undefined ? undefined : `took ${formatDuration(record.durationMs)}`,
        reason === undefined ? undefined : `reason ${reason}`,
        detail === undefined ? undefined : detailExcerpt(detail),
      ]),
    },
    options,
    theme,
  )
}

export const renderReflectionSummaryEntry: EntryRenderer<ReflectionCompletionSummary> = (entry, options, theme) => {
  const summary = entry.data
  if (!summary) return undefined
  const clean = summary.failedCount === 0
  const noun = `completion${summary.count === 1 ? "" : "s"}`
  return noticeComponent(
    {
      glyph: clean ? "●" : "⚠",
      title: `Memory reflection · ${summary.count} older ${noun} collapsed`,
      tone: clean ? "muted" : "warning",
      why: clean
        ? "Delivered while this session was away; none need attention."
        : `Delivered while this session was away; ${summary.failedCount} need attention.`,
      detail: joinFields([
        optionalRendererText(summary.dominantFingerprint) === undefined
          ? undefined
          : `most common ${detailExcerpt(summary.dominantFingerprint)}`,
        optionalRendererText(summary.oldestISO) === undefined ? undefined : `oldest ${normalizeRendererText(summary.oldestISO)}`,
        optionalRendererText(summary.newestISO) === undefined ? undefined : `newest ${normalizeRendererText(summary.newestISO)}`,
      ]),
    },
    options,
    theme,
  )
}

export function registerReflectionCompletionRenderer(api: ReflectionCompletionApi): void {
  api.registerEntryRenderer(REFLECTION_COMPLETION_ENTRY_TYPE, renderReflectionCompletionEntry)
  api.registerEntryRenderer(REFLECTION_LAUNCHED_ENTRY_TYPE, renderReflectionLaunchedEntry)
  api.registerEntryRenderer(REFLECTION_SUMMARY_ENTRY_TYPE, renderReflectionSummaryEntry)
}

function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "unknown"
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`
  const seconds = durationMs / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m${String(Math.round(seconds - minutes * 60)).padStart(2, "0")}s`
}

export async function recordReflectionCompletion(
  completionsDir: string,
  record: ReflectionCompletionRecord,
  live?: ReflectionLiveSession,
): Promise<ReflectionCompletionRecord> {
  const durable = await ensureReflectionCompletion(completionsDir, record)
  if (!live || durable.delivery.status === "consumed") {
    return durable
  }
  const delivered = await deliverRecord(completionsDir, durable, live)
  await live.onCompletion?.(delivered.runId)
  return delivered
}

export async function ensureReflectionCompletion(
  completionsDir: string,
  desired: ReflectionCompletionRecord,
): Promise<ReflectionCompletionRecord> {
  const target = join(completionsDir, `${safeRunId(desired.runId)}.json`)
  const existing = await readRecord(target)
  if (existing !== null) {
    if (!sameCompletion(existing, desired)) {
      throw new Error(`Reflection completion record mismatch for ${desired.runId}`)
    }
    return existing
  }
  await writeRecord(completionsDir, desired)
  return desired
}

export async function readReflectionCompletion(
  completionsDir: string,
  runId: string,
): Promise<ReflectionCompletionRecord | null> {
  return readRecord(join(completionsDir, `${safeRunId(runId)}.json`))
}

export async function consumePendingReflectionCompletions(
  completionsDir: string,
  identity: string,
  live: ReflectionLiveSession,
): Promise<readonly ReflectionCompletionRecord[]> {
  let names: string[]
  try {
    names = (await readdir(completionsDir)).filter((name) => name.endsWith(".json")).sort()
  } catch (error) {
    if (errorCode(error) === "ENOENT") return []
    throw error
  }

  const pending: ReflectionCompletionRecord[] = []
  for (const name of names) {
    const record = await readRecord(join(completionsDir, name))
    if (record?.identity === identity && record.delivery.status === "pending") pending.push(record)
  }
  pending.sort((left, right) => Date.parse(right.finishedAt) - Date.parse(left.finishedAt))

  const cutoff = Date.now() - COMPLETION_MAX_AGE_MS
  const fresh = pending.filter((record) => Date.parse(record.finishedAt) >= cutoff)
  const stale = pending.filter((record) => Date.parse(record.finishedAt) < cutoff)
  const consumed: ReflectionCompletionRecord[] = []
  for (const record of fresh.slice(0, DETAILED_DRAIN_LIMIT)) {
    consumed.push(await deliverRecord(completionsDir, record, live, false))
  }

  const collapsed = fresh.slice(DETAILED_DRAIN_LIMIT)
  if (collapsed.length > 0) {
    live.api.appendEntry(REFLECTION_SUMMARY_ENTRY_TYPE, summarize(collapsed))
    for (const record of collapsed) consumed.push(await markDelivered(completionsDir, record, live.sessionId))
  }
  for (const record of stale) consumed.push(await markDelivered(completionsDir, record, live.sessionId))

  if (fresh.length > 0) {
    safeNotify(live, drainMessage(fresh), fresh.some(isUnsuccessful) ? "warning" : "info")
  }
  return consumed
}

async function deliverRecord(
  completionsDir: string,
  record: ReflectionCompletionRecord,
  live: ReflectionLiveSession,
  notify = true,
): Promise<ReflectionCompletionRecord> {
  const delivered = await markDelivered(completionsDir, record, live.sessionId)
  live.api.appendEntry(REFLECTION_COMPLETION_ENTRY_TYPE, delivered)
  if (notify) safeNotify(live, completionMessage(delivered), completionLevel(delivered.outcome))
  return delivered
}

async function markDelivered(
  completionsDir: string,
  record: ReflectionCompletionRecord,
  sessionId: string,
): Promise<ReflectionCompletionRecord> {
  const delivered: ReflectionCompletionRecord = {
    ...record,
    delivery: {
      status: "consumed",
      sessionId,
      consumedAt: new Date().toISOString(),
    },
  }
  await writeRecord(completionsDir, delivered)
  return delivered
}

function summarize(records: readonly ReflectionCompletionRecord[]): ReflectionCompletionSummary {
  const fingerprints = new Map<string, number>()
  for (const record of records) {
    const fingerprint = completionFingerprint(record)
    fingerprints.set(fingerprint, (fingerprints.get(fingerprint) ?? 0) + 1)
  }
  return {
    schemaVersion: 1,
    count: records.length,
    failedCount: records.filter(isUnsuccessful).length,
    oldestISO: records.at(-1)?.finishedAt ?? "",
    newestISO: records[0]?.finishedAt ?? "",
    dominantFingerprint: [...fingerprints].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0] ?? "",
  }
}

function drainMessage(records: readonly ReflectionCompletionRecord[]): string {
  const failures = records.filter(isUnsuccessful).length
  return failures === 0
    ? `Delivered ${records.length} memory reflection completion${records.length === 1 ? "" : "s"}.`
    : `Delivered ${records.length} memory reflection completions; ${failures} need attention.`
}

function completionFingerprint(record: ReflectionCompletionRecord): string {
  return `${record.reason ?? record.outcome}:${(record.detail ?? "").slice(0, 60)}`
}

function isUnsuccessful(record: ReflectionCompletionRecord): boolean {
  return record.outcome !== "merged" && record.outcome !== "no_changes"
}

export function safeNotify(
  live: ReflectionLiveSession,
  message: string,
  level: "info" | "warning" | "error",
): void {
  if (!live.ui) return
  try {
    live.ui.notify(message, level)
  } catch (error) {
    live.logger?.warn("memory reflection notification failed", { error: describe(error) })
  }
}

function completionMessage(record: ReflectionCompletionRecord): string {
  if (record.outcome === "merged") return `Memory reflection ${record.runId} merged.`
  if (record.outcome === "no_changes") return `Memory reflection ${record.runId} completed with no changes.`
  if (record.outcome === "timed_out") return `Memory reflection ${record.runId} timed out; its transcript cursor was not advanced.`
  return `Memory reflection ${record.runId} ended with ${record.outcome}; its transcript cursor was not advanced.`
}

function completionLevel(outcome: ReflectionOutcome): "info" | "warning" {
  return outcome === "merged" || outcome === "no_changes" ? "info" : "warning"
}

function sameCompletion(
  left: ReflectionCompletionRecord,
  right: ReflectionCompletionRecord,
): boolean {
  return JSON.stringify({ ...left, delivery: undefined })
    === JSON.stringify({ ...right, delivery: undefined })
}

async function writeRecord(completionsDir: string, record: ReflectionCompletionRecord): Promise<void> {
  await mkdir(completionsDir, { recursive: true, mode: 0o700 })
  const target = join(completionsDir, `${safeRunId(record.runId)}.json`)
  const temporary = `${target}.tmp-${randomUUID()}`
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
  await rename(temporary, target)
}

async function readRecord(path: string): Promise<ReflectionCompletionRecord | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"))
    return isCompletionRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function isCompletionRecord(value: unknown): value is ReflectionCompletionRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const delivery = record.delivery
  return record.schemaVersion === 1
    && typeof record.runId === "string"
    && typeof record.identity === "string"
    && typeof record.category === "string"
    && Array.isArray(record.conversationIds)
    && record.conversationIds.every((id) => typeof id === "string")
    && (record.trigger === "manual" || record.trigger === "compaction" || record.trigger === "step-count" || record.trigger === "dream")
    && (record.trigger === "dream"
      ? record.origin === "manual" || record.origin === "idle" || record.origin === "shutdown"
      : record.origin === undefined)
    && typeof record.outcome === "string"
    && typeof record.startedAt === "string"
    && typeof record.finishedAt === "string"
    && !!delivery && typeof delivery === "object" && !Array.isArray(delivery)
    && (((delivery as Record<string, unknown>).status === "pending") || ((delivery as Record<string, unknown>).status === "consumed"))
}

function safeRunId(runId: string): string {
  const safe = basename(runId.trim()).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")
  if (!safe || safe === "." || safe === "..") throw new TypeError("runId must contain a safe identifier")
  return safe.slice(0, 80)
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !("code" in error)) return undefined
  return typeof error.code === "string" ? error.code : undefined
}
