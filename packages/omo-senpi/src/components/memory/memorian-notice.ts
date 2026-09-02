import type { EntryRenderer } from "@code-yeongyu/senpi"

import { joinFields, noticeComponent, normalizeRendererText } from "./worker/entry-renderers"

export const NUDGED_ENTRY_TYPE = "omo-memorian:nudged"
export const GATE_ENTRY_TYPE = "omo-memorian:gate"

export interface MemorianNudgedRecord {
  readonly version: 1
  readonly nudges: readonly { readonly path: string; readonly hint: string }[]
}

export interface MemorianGateRecord {
  readonly version: 1
  readonly status: "skipped" | "failed" | "dropped"
  readonly cause?: string
  readonly model?: string
  readonly candidateCount: number
}

export const renderMemorianNudgedEntry: EntryRenderer<MemorianNudgedRecord> = (entry, options, theme) => {
  const record = entry.data
  if (record?.version !== 1 || !Array.isArray(record.nudges) || record.nudges.length === 0) return undefined
  if (record.nudges.some((nudge) => !isNudge(nudge))) return undefined
  const [first, ...rest] = record.nudges
  if (first === undefined) return undefined
  return noticeComponent({
    glyph: "·",
    title: joinFields(["Memorian nudged", normalizeRendererText(first.hint)]),
    tone: "muted",
    why: "Memorian judged a stored memory relevant to the previous turn; it is a hint, not current state.",
    extra: [
      ...rest.map((nudge) => ({ text: normalizeRendererText(nudge.hint), tone: "dim" as const })),
      ...record.nudges.map((nudge) => ({ text: normalizeRendererText(nudge.path), tone: "dim" as const })),
    ],
  }, options, theme)
}

function isNudge(value: unknown): value is { readonly path: string; readonly hint: string } {
  if (value === null || typeof value !== "object") return false
  const nudge = value as { path?: unknown; hint?: unknown }
  return typeof nudge.path === "string" && nudge.path.length > 0 && typeof nudge.hint === "string" && nudge.hint.length > 0
}

export const renderMemorianGateEntry: EntryRenderer<MemorianGateRecord> = (entry, options, theme) => {
  const record = entry.data
  if (record === undefined || record.version !== 1 || record.candidateCount < 0) return undefined
  if (record.status === "dropped") return undefined
  if (record.status !== "skipped" && record.status !== "failed") return undefined
  const cause = typeof record.cause === "string" ? normalizeRendererText(record.cause) : undefined
  return noticeComponent({
    glyph: record.status === "skipped" ? "⚠" : "✗",
    title: joinFields([`Memorian gate ${record.status === "skipped" ? "skipped" : "failed"}`, cause]),
    tone: record.status === "skipped" ? "warning" : "error",
    why: record.status === "skipped"
      ? "Memorian could not judge the stored memories for the previous turn."
      : "Memorian failed while judging the stored memories for the previous turn.",
  }, options, theme)
}
