import type { TaskRecord, TaskStatus } from "@oh-my-opencode/senpi-task"

import type { IdleInjectionCoordinator } from "../../extension/idle-injection-coordinator"
import type { SenpiExtensionAPI } from "../../extension/types"

export const TEAM_MEMBER_LIVENESS_MESSAGE_TYPE = "senpi-task.team-member-liveness"

export type TeamMemberLivenessDetails = {
  readonly memberName: string
  readonly lastKnownState: TaskStatus
  readonly reason?: string
}

type TeamMemberLivenessDeliveryDetails = TeamMemberLivenessDetails & {
  readonly deliveryKey: string
}

export type TeamMemberLivenessNotifier = {
  notifyTerminal(record: TaskRecord): void
  acknowledgeDelivered(deliveryKey: string): void
}

export type TeamMemberLivenessNotifierDeps = {
  readonly pi: Pick<SenpiExtensionAPI, "sendMessage">
  readonly coordinator?: Pick<IdleInjectionCoordinator, "enqueue" | "scheduleFlush" | "flushSoon">
  readonly isStreaming: () => boolean
  readonly wasDelivered?: (record: TaskRecord) => boolean
  readonly markDelivered?: (record: TaskRecord) => void
}

const TEAM_MEMBER_NAME_PATTERN = /^team:[0-9a-f-]{36}:([a-z0-9-]+)$/i
const DELIVERY_KEY_PREFIX = "team-member-liveness:"
const WAKE_MESSAGE_TYPE = "omo-senpi:wake"

export function createTeamMemberLivenessNotifier(
  deps: TeamMemberLivenessNotifierDeps,
): TeamMemberLivenessNotifier {
  const delivered = new Set<string>()
  const pendingAcknowledgement = new Map<string, TaskRecord>()

  return {
    notifyTerminal(record) {
      const details = livenessDetails(record)
      if (details === undefined || deps.wasDelivered?.(record) === true) return
      const key = `${DELIVERY_KEY_PREFIX}${record.task_id}:${record.notification.run_epoch}`
      if (delivered.has(key)) return
      delivered.add(key)
      pendingAcknowledgement.set(key, record)
      const deliveryDetails: TeamMemberLivenessDeliveryDetails = { ...details, deliveryKey: key }
      const content = livenessContent(details)
      if (deps.coordinator !== undefined) {
        deps.coordinator.enqueue({
          key,
          source: "team-liveness",
          customType: TEAM_MEMBER_LIVENESS_MESSAGE_TYPE,
          content,
          display: false,
          details: deliveryDetails,
        })
        if (deps.isStreaming()) deps.coordinator.scheduleFlush()
        else deps.coordinator.flushSoon()
        return
      }
      try {
        deps.pi.sendMessage({
          customType: TEAM_MEMBER_LIVENESS_MESSAGE_TYPE,
          content,
          display: false,
          details: deliveryDetails,
        }, { triggerTurn: true, deliverAs: "steer" })
      } catch (error) {
        delivered.delete(key)
        pendingAcknowledgement.delete(key)
        throw error
      }
    },
    acknowledgeDelivered(deliveryKey) {
      const record = pendingAcknowledgement.get(deliveryKey)
      if (record === undefined) return
      pendingAcknowledgement.delete(deliveryKey)
      deps.markDelivered?.(record)
    },
  }
}

export function livenessDeliveryKeys(payload: unknown): readonly string[] {
  if (!isRecord(payload) || !isRecord(payload.message)) return []
  const message = payload.message
  if (message.customType === TEAM_MEMBER_LIVENESS_MESSAGE_TYPE) {
    const key = readDeliveryKey(message.details)
    return key === undefined ? [] : [key]
  }
  if (message.customType !== WAKE_MESSAGE_TYPE || !Array.isArray(message.details)) return []
  const keys = new Set<string>()
  for (const entry of message.details) {
    if (!isRecord(entry) || entry.customType !== TEAM_MEMBER_LIVENESS_MESSAGE_TYPE) continue
    const key = readDeliveryKey(entry.details)
    if (key !== undefined) keys.add(key)
  }
  return [...keys]
}

export function livenessDetails(record: TaskRecord): TeamMemberLivenessDetails | undefined {
  const memberName = TEAM_MEMBER_NAME_PATTERN.exec(record.name ?? "")?.[1]
  if (memberName === undefined || (record.status !== "error" && record.status !== "lost")) return undefined
  return {
    memberName,
    lastKnownState: record.status,
    ...(record.error_message === undefined ? {} : { reason: record.error_message }),
  }
}

export function livenessContent(details: TeamMemberLivenessDetails): string {
  const reason = details.reason === undefined ? "" : ` Reason: ${details.reason}`
  return `Team member liveness: ${details.memberName} exited abnormally; last known state: ${details.lastKnownState}.${reason}`
}

function readDeliveryKey(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  const key = value.deliveryKey
  return typeof key === "string" && key.startsWith(DELIVERY_KEY_PREFIX) ? key : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
