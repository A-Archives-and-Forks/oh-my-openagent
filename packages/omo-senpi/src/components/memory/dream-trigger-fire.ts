import type { CapturedConversation, DreamOrigin } from "@oh-my-opencode/memory-core"

import { computeUnreflectedVolume, selectDreamConversations } from "./dream-selector"
import { evaluateDreamGates, readLastDreamAtMs, type DreamTriggerSettings } from "./dream-trigger-gates"
import type { DreamFireOutcome, DreamTriggerSession, ManualDreamRequest } from "./dream-trigger"

export async function fireDream(input: {
  readonly session: DreamTriggerSession
  readonly origin: DreamOrigin
  readonly settings: DreamTriggerSettings
  readonly request: ManualDreamRequest & { readonly signal?: AbortSignal }
  readonly now: () => number
  readonly warnLaunchFailure: (error: unknown) => void
}): Promise<DreamFireOutcome> {
  const { session, origin, settings, request, now } = input
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
  if (isAborted(request.signal)) return { fired: false, rejection: "aborted" }
  if (result.status === "active") {
    try {
      session.launch(result.run)
    } catch (error: unknown) {
      input.warnLaunchFailure(error)
    }
  }
  return { fired: true, runId: result.run.runId, status: result.status }
}

/** Live read of the drain signal: AbortSignal.aborted mutates externally, so it is never narrowed. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}
