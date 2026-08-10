import { describe, expect, test } from "bun:test"
import path from "node:path"

import {
  LOCK_DOMAINS,
  factsQueueLockPath,
  memoryWriterLockPath,
  noticeLockPath,
  reflectionSchedulerLockPath,
  skillsUsageLockPath,
  transcriptStateLockPath,
} from "./index"

describe("lock domain paths", () => {
  test("#given the runtime lock directory #when domain paths are resolved #then every protocol has a stable confined name", () => {
    // #given
    const locksDirectory = path.join("runtime", "locks")

    // #when
    const paths = [
      memoryWriterLockPath(locksDirectory),
      reflectionSchedulerLockPath(locksDirectory),
      skillsUsageLockPath(locksDirectory),
      transcriptStateLockPath(locksDirectory, "conversation/../one"),
      factsQueueLockPath(locksDirectory),
      noticeLockPath(locksDirectory),
    ]

    // #then
    expect(LOCK_DOMAINS).toEqual([
      "memory-write",
      "reflection-scheduler",
      "transcript-state",
      "skills-usage",
      "facts-queue",
      "notice",
    ])
    expect(paths[0]).toBe(path.join(locksDirectory, "memory-write.lock"))
    expect(paths[1]).toBe(path.join(locksDirectory, "reflection-scheduler.lock"))
    expect(paths[2]).toBe(path.join(locksDirectory, "skills-usage.lock"))
    expect(path.dirname(paths[3] ?? "")).toBe(locksDirectory)
    expect(path.basename(paths[3] ?? "")).toMatch(/^transcript-state-[a-f0-9]{16}\.lock$/)
    expect(paths[4]).toBe(path.join(locksDirectory, "facts-queue.lock"))
    expect(paths[5]).toBe(path.join(locksDirectory, "notice.lock"))
  })
})
