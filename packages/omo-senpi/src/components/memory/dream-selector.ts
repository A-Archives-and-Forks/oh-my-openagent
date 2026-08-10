import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"

import {
  TranscriptJournal,
  captureCursorSnapshot,
  deriveState,
  initialReflectionState,
  searchTranscripts,
  type ReflectionTranscriptState,
  type SearchDocument,
  type TranscriptEntry,
} from "@oh-my-opencode/memory-core"

export interface DreamSelectionMode {
  readonly focus?: string
}

export interface DreamSelectorOptions {
  readonly transcriptsDir: string
  readonly currentConversationId?: string
  readonly autoSelectMax: number
  readonly autoSelectMaxBytes: number
  readonly now: () => Date
}

export interface DreamScoreOperands {
  readonly searchHits: number
  readonly unreflectedSteps: number
  readonly recency: number
  readonly sourceCount: number
  readonly sizeFit: number
  readonly isCurrent: number
  readonly penalty: number
}

export interface DreamScoredConversation {
  readonly conversationId: string
  readonly totalBytes: number
  readonly lastActivityMs: number
  readonly operands: DreamScoreOperands
  readonly score: number
}

export interface DreamSelection {
  readonly conversationIds: readonly string[]
  readonly totalBytes: number
}

export interface DreamScoreInput {
  readonly searchMatchCount: number
  readonly stepsSinceLastSuccessfulReflection: number
  readonly lastActivity: string
  readonly distinctSourceCount: number
  readonly totalBytes: number
  readonly targetBytes: number
  readonly isCurrent: boolean
  readonly newestMessageCovered: boolean
  readonly now: Date
}

interface LoadedConversation {
  readonly conversationId: string
  readonly entries: readonly TranscriptEntry[]
  readonly stepsSinceLastSuccessfulReflection: number
  readonly reflectedThroughMessageId?: string
  readonly newestMessageId: string
  readonly lastActivity: string
  readonly totalBytes: number
}

export function scoreDreamCandidate(input: DreamScoreInput): Pick<DreamScoredConversation, "operands" | "score"> {
  const ageHours = Math.max(0, input.now.getTime() - Date.parse(input.lastActivity)) / 3_600_000
  const recency = Number.isFinite(ageHours) ? Math.min(1, Math.exp(-ageHours / 168)) : 0
  const operands: DreamScoreOperands = {
    searchHits: Math.min(10, Math.max(0, input.searchMatchCount)) / 10,
    unreflectedSteps: Math.min(50, Math.max(0, input.stepsSinceLastSuccessfulReflection)) / 50,
    recency,
    sourceCount: Math.min(200, Math.max(0, input.distinctSourceCount)) / 200,
    sizeFit: input.totalBytes <= input.targetBytes || input.totalBytes === 0
      ? 1
      : Math.min(1, input.targetBytes / input.totalBytes),
    isCurrent: input.isCurrent ? 1 : 0,
    penalty: input.newestMessageCovered ? 1 : 0,
  }
  return {
    operands,
    score: 50 * operands.searchHits
      + operands.unreflectedSteps
      + operands.recency
      + operands.sourceCount
      + operands.sizeFit
      + operands.isCurrent
      - operands.penalty,
  }
}

export function rankDreamCandidates(
  candidates: readonly DreamScoredConversation[],
): DreamScoredConversation[] {
  return [...candidates].sort((left, right) => {
    if (left.score !== right.score) return right.score - left.score
    if (left.operands.unreflectedSteps !== right.operands.unreflectedSteps) {
      return right.operands.unreflectedSteps - left.operands.unreflectedSteps
    }
    if (left.lastActivityMs !== right.lastActivityMs) return right.lastActivityMs - left.lastActivityMs
    return compareConversationIds(left.conversationId, right.conversationId)
  })
}

export function packDreamCandidates(
  ranked: readonly DreamScoredConversation[],
  caps: { readonly maxConversations: number; readonly maxBytes: number },
): DreamSelection {
  const conversationIds: string[] = []
  let totalBytes = 0
  for (const candidate of ranked) {
    if (conversationIds.length >= caps.maxConversations) break
    if (candidate.totalBytes > caps.maxBytes - totalBytes) continue
    conversationIds.push(candidate.conversationId)
    totalBytes += candidate.totalBytes
  }
  return { conversationIds, totalBytes }
}

export async function computeUnreflectedVolume(options: DreamSelectorOptions): Promise<number> {
  const conversations = await loadConversations(options.transcriptsDir)
  return conversations.reduce((total, conversation) => total + conversation.totalBytes, 0)
}

export async function selectDreamConversations(
  options: DreamSelectorOptions,
  mode: DreamSelectionMode = {},
): Promise<DreamSelection> {
  const conversations = await loadConversations(options.transcriptsDir)
  const targetBytes = options.autoSelectMaxBytes / options.autoSelectMax
  const now = options.now()
  const candidates = conversations.map((conversation): DreamScoredConversation => {
    const scored = scoreDreamCandidate({
      searchMatchCount: countSearchMatches(conversation, mode.focus),
      stepsSinceLastSuccessfulReflection: conversation.stepsSinceLastSuccessfulReflection,
      lastActivity: conversation.lastActivity,
      distinctSourceCount: new Set(conversation.entries.map((entry) => entry.source_message_id)).size,
      totalBytes: conversation.totalBytes,
      targetBytes,
      isCurrent: conversation.conversationId === options.currentConversationId,
      newestMessageCovered: conversation.reflectedThroughMessageId === conversation.newestMessageId,
      now,
    })
    return {
      conversationId: conversation.conversationId,
      totalBytes: conversation.totalBytes,
      lastActivityMs: Date.parse(conversation.lastActivity),
      ...scored,
    }
  })
  return packDreamCandidates(rankDreamCandidates(candidates), {
    maxConversations: options.autoSelectMax,
    maxBytes: options.autoSelectMaxBytes,
  })
}

async function loadConversations(transcriptsDir: string): Promise<LoadedConversation[]> {
  const entries = await readdir(transcriptsDir, { withFileTypes: true }).catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") return []
    throw error
  })
  const names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(compareConversationIds)
  const conversations = await Promise.all(names.map(async (conversationId): Promise<LoadedConversation | null> => {
    const journalDir = join(transcriptsDir, conversationId)
    const journalEntries = await new TranscriptJournal({ journalDir }).readEntries()
    const state = await readReflectionState(join(journalDir, "state.json"), journalEntries)
    const snapshot = captureCursorSnapshot(journalEntries, state)
    const newest = journalEntries.at(-1)
    if (snapshot === null || newest === undefined) return null
    return {
      conversationId,
      entries: journalEntries,
      stepsSinceLastSuccessfulReflection: state.steps_since_last_successful_reflection,
      reflectedThroughMessageId: state.reflected_through_message_id,
      newestMessageId: newest.source_message_id,
      lastActivity: newest.captured_at,
      totalBytes: conversationByteLength(snapshot.entries),
    }
  }))
  return conversations.filter((conversation): conversation is LoadedConversation => conversation !== null)
}

async function readReflectionState(
  statePath: string,
  entries: readonly TranscriptEntry[],
): Promise<ReflectionTranscriptState> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(statePath, "utf8"))
  } catch (error) {
    if (errorCode(error) !== "ENOENT" && !(error instanceof SyntaxError)) throw error
  }
  const value = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {}
  const reflectedThrough = typeof value.reflected_through_message_id === "string"
    && value.reflected_through_message_id.length > 0
    ? value.reflected_through_message_id
    : undefined
  const reflectedSteps = typeof value.reflected_completed_steps === "number"
    && Number.isInteger(value.reflected_completed_steps)
    && value.reflected_completed_steps >= 0
    ? value.reflected_completed_steps
    : 0
  return deriveState({
    ...initialReflectionState(),
    ...(reflectedThrough === undefined ? {} : { reflected_through_message_id: reflectedThrough }),
    reflected_completed_steps: reflectedSteps,
  }, entries)
}

function conversationByteLength(entries: readonly TranscriptEntry[]): number {
  const text = entries
    .map((entry) => {
      const fields: string[] = []
      if ("text" in entry) fields.push(entry.text)
      if (entry.kind === "tool_call" && entry.argsText !== undefined) fields.push(entry.argsText)
      if (entry.kind === "tool_call" && entry.resultText !== undefined) fields.push(entry.resultText)
      return fields.join("\n")
    })
    .filter((entry) => entry.length > 0)
    .join("\n")
  return Buffer.byteLength(text, "utf8")
}

function countSearchMatches(conversation: LoadedConversation, focus: string | undefined): number {
  if (focus === undefined || focus.trim().length === 0) return 0
  return searchTranscripts(
    { listConversations: () => [{ id: conversation.conversationId, messages: searchDocuments(conversation) }] },
    focus,
    { conversationId: conversation.conversationId, limit: 10 },
  ).length
}

function searchDocuments(conversation: LoadedConversation): SearchDocument[] {
  const grouped = new Map<string, TranscriptEntry[]>()
  for (const entry of conversation.entries) {
    const group = grouped.get(entry.source_message_id) ?? []
    group.push(entry)
    grouped.set(entry.source_message_id, group)
  }
  return [...grouped].map(([messageId, entries]) => {
    const textEntries = entries.filter((entry) => entry.kind !== "tool_call")
    const tools = entries.filter((entry) => entry.kind === "tool_call")
    const content = textEntries
      .filter((entry) => entry.kind !== "reasoning")
      .map((entry) => entry.text)
      .join("\n")
    const reasoning = textEntries
      .filter((entry) => entry.kind === "reasoning")
      .map((entry) => entry.text)
      .join("\n")
    return {
      id: messageId,
      conversationId: conversation.conversationId,
      date: entries.at(-1)?.captured_at,
      messageType: entries[0]?.kind,
      content,
      reasoning,
      toolCalls: tools.map((entry) => ({ name: entry.name, arguments: entry.argsText })),
      toolReturn: tools.map((entry) => entry.resultText).filter((text) => text !== undefined).join("\n"),
    }
  })
}

function compareConversationIds(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !("code" in error)) return undefined
  return typeof error.code === "string" ? error.code : undefined
}
