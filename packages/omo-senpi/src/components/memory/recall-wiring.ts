// Memorian Phase A recall injection (plan .omo/plans/memorian-recall-m1.md unit 3).
//
// Recall runs as its OWN before_agent_start handler, NOT as an extra field on the memory prompt
// handler's result: senpi's ExtensionRunner.emitBeforeAgentStart pushes every handler's
// `result.message` into a combined `messages[]` array, so two handlers of the same extension each
// contribute one message. That separation is the invariant that keeps recall away from
// systemPrompt: this module returns `message` only, so the compiled memory projection and the
// provider prompt cache are never touched by a recall hit.
//
// The hint is read-only advice, so EVERY step is fail-open: an unreadable memory repo, a corrupt
// ledger, or a receipt write failure drops the injection and logs, and the turn proceeds untouched.

import type { OmoMemorySettings } from "@oh-my-opencode/omo-config-core"
import {
  GitMemoryRepo,
  RecallCorpusCache,
  RecallLedger,
  appendRecallReceipt,
  planRecallQueries,
  renderRecallMessage,
  selectRecallCandidates,
} from "@oh-my-opencode/memory-core"

import type { ComponentLogger } from "../../extension/types"
import type { MemoryExtensionAPI } from "./capabilities"
import type { MemoryIdentityContext } from "./context"
import { MEMORY_NOTICE_CUSTOM_TYPE } from "./prompt"
import { renderRecallEntry, type MemoryRecallRecord } from "./recall-notice"
import { resolveMemorySettings } from "./identity-runtime"

export interface ResolvedMemoryRecallSettings {
  readonly enabled: boolean
  readonly max_items: number
  readonly budget_tokens: number
  readonly excerpt_chars: number
  readonly min_score?: number
  readonly exclude: readonly string[]
}

/** Base recall block under the bound agent's layer override, mirroring the nudge/reflection pattern. */
export function resolveAgentRecallSettings(
  settings: OmoMemorySettings | undefined,
  agentId: string,
): ResolvedMemoryRecallSettings {
  const resolved = resolveMemorySettings(settings)
  return { ...resolved.recall, ...resolved.agents[agentId]?.recall }
}

export const RECALL_CUSTOM_TYPE = "omo-memorian:recall"

/**
 * Same 4-chars-per-token approximation status.ts `estimateSystemTokens` uses for the system
 * advisory. Recall only needs a ceiling, so one shared heuristic beats a tokenizer dependency.
 */
const CHARS_PER_TOKEN = 4

/** Newest conversation texts feeding the query planner; older turns are not what the user is on. */
const RECALL_TEXT_WINDOW = 6

// Memory-owned hidden channels. Their content is derived FROM memory, so feeding them back into
// the query planner would make recall search for the hint it just injected.
const EXCLUDED_CUSTOM_TYPES: ReadonlySet<string> = new Set([RECALL_CUSTOM_TYPE, MEMORY_NOTICE_CUSTOM_TYPE])

export interface MemoryRecallWiringOptions {
  readonly resolveContext: (sessionId: string) => MemoryIdentityContext | undefined
  /** Full memory settings; the bound agent's recall override is applied internally. */
  readonly resolveSettings: () => OmoMemorySettings
  readonly env: Record<string, string | undefined>
  readonly createRepo?: (context: MemoryIdentityContext) => GitMemoryRepo
  readonly corpusCache?: RecallCorpusCache
  readonly ledgerFor?: (context: MemoryIdentityContext) => RecallLedger
  readonly appendReceipt?: typeof appendRecallReceipt
  readonly logger?: ComponentLogger
}

export interface MemoryRecallWiring {
  register(pi: MemoryExtensionAPI): void
}

// A memory worker child must never receive recall hints: it reasons ABOUT memory, and an injected
// hint would both pollute its transcript and re-enter memory on the next extraction pass.
const CHILD_SENTINELS = ["SENPI_MEMORY_REFLECTION", "SENPI_MEMORY_FACTS"] as const

export function createMemoryRecallWiring(options: MemoryRecallWiringOptions): MemoryRecallWiring {
  const corpusCache = options.corpusCache ?? new RecallCorpusCache()
  const createRepo = options.createRepo ?? defaultCreateRepo
  const ledgerFor = options.ledgerFor ?? ((context) => new RecallLedger(context.identityPaths.recallLedger))
  const appendReceipt = options.appendReceipt ?? appendRecallReceipt

  async function handle(payload: unknown, eventCtx: unknown): Promise<RecallInjection | undefined> {
    if (!isBeforeAgentStart(payload)) return undefined
    if (CHILD_SENTINELS.some((sentinel) => options.env[sentinel] === "1")) return undefined
    const session = readSession(eventCtx)
    if (session === undefined) return undefined
    const context = options.resolveContext(session.id)
    if (context === undefined) return undefined

    const recall = resolveAgentRecallSettings(options.resolveSettings(), context.identity)
    if (recall.enabled === false) return undefined

    const texts = recentTexts(session.entries)
    if (texts.length === 0) return undefined
    const queries = planRecallQueries(texts)
    if (queries.length === 0) return undefined

    const repo = createRepo(context)
    const corpus = await corpusCache.load(repo)
    if (corpus.documents.length === 0) return undefined

    const ledger = ledgerFor(context)
    const candidates = selectRecallCandidates(corpus.documents, queries, {
      maxItems: recall.max_items,
      excerptChars: recall.excerpt_chars,
      ...(recall.min_score === undefined ? {} : { minScore: recall.min_score }),
      exclude: recall.exclude,
      surfaced: await ledger.surfacedPaths(session.id),
    })
    if (candidates.length === 0) return undefined

    const content = withinBudget(renderRecallMessage(candidates), recall.budget_tokens)
    if (content.length === 0) return undefined

    await ledger.markSurfaced(
      session.id,
      candidates.map((candidate) => ({ path: candidate.path, hash: corpus.revision ?? "unknown" })),
    )
    await appendReceipt(context.identityPaths.recallReceipts, {
      sessionId: session.id,
      at: new Date().toISOString(),
      queries,
      injected: candidates.map((candidate) => ({ path: candidate.path, score: candidate.score })),
    })
    return {
      result: { message: { customType: RECALL_CUSTOM_TYPE, content, display: false } },
      paths: candidates.map((candidate) => candidate.path),
    }
  }

  return {
    register(pi): void {
      pi.registerEntryRenderer(RECALL_CUSTOM_TYPE, renderRecallEntry)
      pi.on("before_agent_start", async (payload, eventCtx) => {
        try {
          const result = await handle(payload, eventCtx)
          if (result !== undefined) {
            // Visible half of the injection: the model-facing message is display:false, so without
            // this entry the user would see a memory-shaped answer with no trace of the hint.
            pi.appendEntry(RECALL_CUSTOM_TYPE, { paths: result.paths } satisfies MemoryRecallRecord)
          }
          return result?.result
        } catch (error) {
          // Read-only advice: any failure skips the injection and leaves the turn untouched.
          options.logger?.warn("omo-senpi memory recall skipped", { error: describe(error) })
          return undefined
        }
      })
    },
  }
}

interface RecallInjection {
  readonly result: {
    readonly message: {
      readonly customType: typeof RECALL_CUSTOM_TYPE
      readonly content: string
      readonly display: false
    }
  }
  readonly paths: readonly string[]
}

/** Hard ceiling on the injected block, applied to the rendered text as whole lines. */
function withinBudget(block: string, budgetTokens: number): string {
  const maxChars = Math.max(0, budgetTokens) * CHARS_PER_TOKEN
  if (block.length <= maxChars) return block
  return block.slice(0, maxChars).trimEnd()
}

interface RecallSession {
  readonly id: string
  readonly entries: readonly unknown[]
}

function readSession(eventCtx: unknown): RecallSession | undefined {
  if (!isRecord(eventCtx)) return undefined
  const manager = eventCtx.sessionManager
  if (!isRecord(manager)) return undefined
  const getSessionId = manager.getSessionId
  const getBranch = manager.getBranch
  if (typeof getSessionId !== "function" || typeof getBranch !== "function") return undefined
  const id = Reflect.apply(getSessionId, manager, [])
  const entries = Reflect.apply(getBranch, manager, [])
  if (typeof id !== "string" || id.length === 0 || !Array.isArray(entries)) return undefined
  return { id, entries }
}

/**
 * Newest-first conversation texts for the planner. Memory-owned hidden custom messages are
 * skipped: senpi persists an injected recall block as a `custom_message` branch entry, so an
 * unfiltered window would rediscover the previous hint instead of the live conversation.
 */
function recentTexts(entries: readonly unknown[]): string[] {
  const texts: string[] = []
  for (let index = entries.length - 1; index >= 0 && texts.length < RECALL_TEXT_WINDOW; index -= 1) {
    const text = conversationText(entries[index])
    if (text !== undefined) texts.push(text)
  }
  return texts
}

function conversationText(entry: unknown): string | undefined {
  if (!isRecord(entry)) return undefined
  if (entry.type === "custom_message" || entry.type === "custom") return undefined
  if (entry.type !== "message") return undefined
  const message = entry.message
  if (!isRecord(message)) return undefined
  const role = message.role
  if (role !== "user" && role !== "assistant") return undefined
  if (typeof message.customType === "string" && EXCLUDED_CUSTOM_TYPES.has(message.customType)) return undefined
  const text = textOf(message.content)
  return text.trim().length === 0 ? undefined : text
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  const parts: string[] = []
  for (const block of content) {
    if (!isRecord(block) || block.type !== "text") continue
    if (typeof block.text === "string") parts.push(block.text)
  }
  return parts.join("\n")
}

function isBeforeAgentStart(payload: unknown): boolean {
  return isRecord(payload) && payload.type === "before_agent_start"
}

function defaultCreateRepo(context: MemoryIdentityContext): GitMemoryRepo {
  return new GitMemoryRepo({ dir: context.identityPaths.repo, agentId: context.identity })
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
