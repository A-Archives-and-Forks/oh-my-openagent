import type { EntryRenderer } from "@code-yeongyu/senpi"
import { normalizeRendererText } from "@oh-my-opencode/senpi-task/renderer-text"
import { linesComponent } from "@oh-my-opencode/senpi-task/task-renderers"

import {
  REFLECTION_COMPLETION_ENTRY_TYPE,
  REFLECTION_LAUNCHED_ENTRY_TYPE,
  type ReflectionCompletionApi,
  type ReflectionCompletionRecord,
  type ReflectionLaunchedEntry,
} from "./completion-contracts"

export function reflectionLaunchedText(launched: ReflectionLaunchedEntry): string {
  return `memory reflection started run:${normalizeRendererText(launched.runId)} trigger:${normalizeRendererText(launched.trigger)} (+${launched.backlogSteps} steps)`
}

export const renderReflectionLaunchedEntry: EntryRenderer<ReflectionLaunchedEntry> = (entry) => {
  const launched = entry.data
  return launched === undefined ? undefined : linesComponent([reflectionLaunchedText(launched)])
}

export const renderReflectionCompletionEntry: EntryRenderer<ReflectionCompletionRecord> = (entry) => {
  const record = entry.data
  if (!record) return undefined
  const detail = record.detail ? [`detail:${normalizeRendererText(record.detail)}`] : []
  return linesComponent([
    `memory reflection ${normalizeRendererText(record.outcome)}`,
    `run:${normalizeRendererText(record.runId)} category:${normalizeRendererText(record.category)}`,
    ...detail,
  ])
}

export function registerReflectionCompletionRenderer(api: ReflectionCompletionApi): void {
  api.registerEntryRenderer(REFLECTION_COMPLETION_ENTRY_TYPE, renderReflectionCompletionEntry)
  api.registerEntryRenderer(REFLECTION_LAUNCHED_ENTRY_TYPE, renderReflectionLaunchedEntry)
}
