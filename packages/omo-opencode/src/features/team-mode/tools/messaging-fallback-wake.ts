import type { TeamModeConfig } from "../../../config/schema/team-mode"
import {
  dispatchInternalPrompt,
  isInternalPromptDispatchAccepted,
} from "../../../hooks/shared/prompt-async-gate"
import { log } from "../../../shared/logger"
import { buildMemberPromptBody } from "../member-session-routing"
import { listUnreadMessages } from "@oh-my-opencode/team-core/team-mailbox/inbox"
import { loadRuntimeState } from "@oh-my-opencode/team-core/team-state-store/store"
import type { RuntimeState } from "@oh-my-opencode/team-core/types"
import type { LiveDeliveryClient } from "./messaging-live-delivery-client"

type RuntimeMember = RuntimeState["members"][number]

export async function enqueueFallbackMailboxWake(input: {
  readonly client: LiveDeliveryClient
  readonly recipientMember: RuntimeMember
  readonly recipientSessionId: string
  readonly directory: string
  readonly teamRunId: string
  readonly recipientName: string
  readonly messageId: string
  readonly config: TeamModeConfig
}): Promise<void> {
  const promptResult = await dispatchInternalPrompt({
    mode: "async",
    client: input.client,
    sessionID: input.recipientSessionId,
    source: "team-live-delivery-fallback",
    queueBehavior: "enqueue",
    shouldDispatch: () => shouldDispatchFallbackMailboxWake(input),
    input: {
      path: { id: input.recipientSessionId },
      body: buildMemberPromptBody(input.recipientMember, "You have a new team message in your mailbox."),
      query: { directory: input.recipientMember.worktreePath ?? input.directory },
    },
  })
  if (isInternalPromptDispatchAccepted(promptResult)) return

  log("[team-mailbox] fallback mailbox wake was not accepted", {
    status: promptResult.status,
    teamRunId: input.teamRunId,
    recipient: input.recipientName,
    recipientSessionId: input.recipientSessionId,
    messageId: input.messageId,
  })
}

async function shouldDispatchFallbackMailboxWake(input: {
  readonly teamRunId: string
  readonly recipientName: string
  readonly recipientSessionId: string
  readonly messageId: string
  readonly config: TeamModeConfig
}): Promise<boolean> {
  try {
    const runtimeState = await loadRuntimeState(input.teamRunId, input.config)
    const recipient = runtimeState.members.find((member) => member.name === input.recipientName)
    const recipientIsActive = recipient?.status === "running" || recipient?.status === "idle"
    if (
      runtimeState.status !== "active"
      || recipient?.sessionId !== input.recipientSessionId
      || !recipientIsActive
    ) {
      return false
    }

    const unread = await listUnreadMessages(input.teamRunId, input.recipientName, input.config)
    return unread.some((message) => message.messageId === input.messageId)
  } catch (error) {
    log("[team-mailbox] fallback mailbox wake cancelled during revalidation", {
      teamRunId: input.teamRunId,
      recipient: input.recipientName,
      recipientSessionId: input.recipientSessionId,
      messageId: input.messageId,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}
