import { describe, expect, test } from "bun:test"

import { getProcessStartIdentity } from "@oh-my-opencode/memory-core"

import { getSupervisorProcessStart } from "./supervisor-process-identity"

function scheme(identity: string | null): string | null {
  if (identity === null) return null
  const separator = identity.indexOf(":")
  return separator <= 0 ? null : identity.slice(0, separator)
}

describe("supervisor start identity", () => {
  test("#given one runtime records a pid as the supervisor and reads it back as the parent #when both identities are compared #then they share one scheme", async () => {
    // when
    const recorded = await getSupervisorProcessStart(process.pid)
    const actual = await getProcessStartIdentity(process.pid)

    // then
    if (process.platform === "win32") {
      // win32 keeps a documented null identity so an abruptly dead supervisor
      // still reconciles through the non-destructive UNKNOWN path.
      expect(recorded).toBeNull()
      return
    }
    expect(recorded).not.toBeNull()
    expect(scheme(recorded)).toBe(scheme(actual))
  })
})
