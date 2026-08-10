import { createHash } from "node:crypto"
import path from "node:path"

export const LOCK_DOMAINS = [
  "memory-write",
  "reflection-scheduler",
  "transcript-state",
  "skills-usage",
  "facts-queue",
  "notice",
] as const

export type LockDomain = (typeof LOCK_DOMAINS)[number]

export function memoryWriterLockPath(locksDirectory: string): string {
  return path.join(locksDirectory, "memory-write.lock")
}

export function reflectionSchedulerLockPath(locksDirectory: string): string {
  return path.join(locksDirectory, "reflection-scheduler.lock")
}

export function transcriptStateLockPath(locksDirectory: string, transcriptId: string): string {
  if (transcriptId.length === 0) throw new Error("transcript id must not be empty")
  const digest = createHash("sha256").update(transcriptId).digest("hex").slice(0, 16)
  return path.join(locksDirectory, `transcript-state-${digest}.lock`)
}

export function skillsUsageLockPath(locksDirectory: string): string {
  return path.join(locksDirectory, "skills-usage.lock")
}

export function factsQueueLockPath(locksDirectory: string): string {
  return path.join(locksDirectory, "facts-queue.lock")
}

export function noticeLockPath(locksDirectory: string): string {
  return path.join(locksDirectory, "notice.lock")
}
