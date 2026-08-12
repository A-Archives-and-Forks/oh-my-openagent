import { describe, expect, test } from "bun:test"

import { runMemoryModelAttempts, type MemoryModelChain } from "./memory-model-attempts"
import type { ReflectionChildResult } from "./spawn"

const candidates: MemoryModelChain = [
  { model: "extension-only/primary", thinking: "off" },
  { model: "builtin/fallback", thinking: "minimal" },
]

function child(overrides: Partial<ReflectionChildResult>): ReflectionChildResult {
  return {
    code: 1,
    signal: null,
    stdout: "",
    stderr: "",
    timedOut: false,
    ...overrides,
  }
}

describe("runMemoryModelAttempts", () => {
  test("#given an exact model-not-found startup error #when a fallback exists #then it retries the fallback", async () => {
    // given
    const attempted: string[] = []

    // when
    const result = await runMemoryModelAttempts(candidates, async (candidate) => {
      attempted.push(candidate.model)
      return candidate.model === "extension-only/primary"
        ? child({ stderr: 'Error: Model "extension-only/primary" not found. Use --list-models to see available models.' })
        : child({ code: 0 })
    })

    // then
    expect(attempted).toEqual(["extension-only/primary", "builtin/fallback"])
    expect(result.candidate.model).toBe("builtin/fallback")
    expect(result.child.code).toBe(0)
  })

  test("#given a generic child failure #when a fallback exists #then it does not retry", async () => {
    // given
    const attempted: string[] = []

    // when
    const result = await runMemoryModelAttempts(candidates, async (candidate) => {
      attempted.push(candidate.model)
      return child({ stderr: "provider request failed" })
    })

    // then
    expect(attempted).toEqual(["extension-only/primary"])
    expect(result.child.stderr).toBe("provider request failed")
  })

  test("#given a timed-out child #when a fallback exists #then it does not retry", async () => {
    // given
    const attempted: string[] = []

    // when
    const result = await runMemoryModelAttempts(candidates, async (candidate) => {
      attempted.push(candidate.model)
      return child({ timedOut: true })
    })

    // then
    expect(attempted).toEqual(["extension-only/primary"])
    expect(result.child.timedOut).toBe(true)
  })
})
