import { describe, expect, test } from "bun:test"

import {
  createRecallOpenerPicker,
  DEFAULT_RECALL_OPENER,
  isValidOpener,
  RECALL_OPENER_MAX_CHARS,
  RECALL_OPENERS,
} from "./memorian-openers"

describe("recall opener pool", () => {
  test("#given the shipped pool #then it holds exactly 100 unique valid lead-ins", () => {
    expect(RECALL_OPENERS).toHaveLength(100)
    expect(new Set(RECALL_OPENERS).size).toBe(RECALL_OPENERS.length)
    for (const opener of RECALL_OPENERS) {
      expect(isValidOpener(opener)).toBe(true)
      expect(opener.endsWith(" —")).toBe(true)
      expect(opener).toBe(opener.trim())
    }
  })

  test("#given the shipped pool #then no entry reads as an insight or doubles the body's verb", () => {
    // The body line beneath the title is "just remembered: <hint>", so an opener that says
    // "remember" would read "remembered — just remembered:", and "aha"/"eureka" is the
    // discovery framing this pool replaces.
    for (const opener of RECALL_OPENERS) expect(opener).not.toMatch(/aha|eureka|remember/iu)
  })

  test("#given the default opener #then it is a pool member", () => {
    expect(DEFAULT_RECALL_OPENER).toBe("Oh, right —")
    expect(RECALL_OPENERS).toContain(DEFAULT_RECALL_OPENER)
  })
})

describe("isValidOpener", () => {
  test("#given a short single-line phrase #then it is valid", () => {
    expect(isValidOpener("Come to think of it —")).toBe(true)
    expect(isValidOpener("x".repeat(RECALL_OPENER_MAX_CHARS))).toBe(true)
  })

  test("#given empty, overlong, multi-line, control-bearing, or non-string input #then it is invalid", () => {
    expect(isValidOpener("")).toBe(false)
    expect(isValidOpener("   ")).toBe(false)
    expect(isValidOpener("x".repeat(RECALL_OPENER_MAX_CHARS + 1))).toBe(false)
    expect(isValidOpener("first\nsecond")).toBe(false)
    expect(isValidOpener("Oh,\u001b[31m right —")).toBe(false)
    expect(isValidOpener(42)).toBe(false)
    expect(isValidOpener(undefined)).toBe(false)
  })
})

describe("createRecallOpenerPicker", () => {
  test("#given a constant rng #when one session picks twice #then the second pick avoids the first while another session may repeat it", () => {
    const picker = createRecallOpenerPicker({ random: () => 0 })
    expect(picker.pick("s1")).toBe(RECALL_OPENERS[0])
    expect(picker.pick("s1")).toBe(RECALL_OPENERS[1])
    expect(picker.pick("s2")).toBe(RECALL_OPENERS[0])
  })

  test("#given a forgotten session #when it picks again #then the previous opener is eligible again", () => {
    const picker = createRecallOpenerPicker({ random: () => 0 })
    expect(picker.pick("s1")).toBe(RECALL_OPENERS[0])
    picker.forget("s1")
    expect(picker.pick("s1")).toBe(RECALL_OPENERS[0])
  })

  test("#given a single-entry pool #when a session picks twice #then the same entry is returned", () => {
    const picker = createRecallOpenerPicker({ random: () => 0.99, pool: ["Only one —"] })
    expect(picker.pick("s1")).toBe("Only one —")
    expect(picker.pick("s1")).toBe("Only one —")
  })

  test("#given a seeded rng #when a session picks many times #then every pick is a pool member and no two consecutive picks repeat", () => {
    let seed = 1234
    const lcg = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    const picker = createRecallOpenerPicker({ random: lcg })
    const pool = new Set(RECALL_OPENERS)
    let previous: string | undefined
    for (let i = 0; i < 500; i += 1) {
      const opener = picker.pick("s1")
      expect(pool.has(opener)).toBe(true)
      expect(opener).not.toBe(previous)
      previous = opener
    }
  })

  test("#given an out-of-range rng #when picking #then the index is clamped into the pool", () => {
    expect(createRecallOpenerPicker({ random: () => 1 }).pick("s1")).toBe(RECALL_OPENERS[RECALL_OPENERS.length - 1])
    expect(createRecallOpenerPicker({ random: () => -1 }).pick("s1")).toBe(RECALL_OPENERS[0])
    expect(createRecallOpenerPicker({ random: () => Number.NaN }).pick("s1")).toBe(RECALL_OPENERS[0])
  })
})
