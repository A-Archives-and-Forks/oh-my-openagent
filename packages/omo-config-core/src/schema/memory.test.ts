import { describe, expect, test } from "bun:test"

import {
  OmoMemorySettingsLayerSchema,
  OmoMemorySettingsSchema,
  type OmoMemorySettings,
} from "./memory"

const FULL_DEFAULTS: OmoMemorySettings = {
  enabled: true,
  agent: "auto",
  tool_exposure: "direct",
  reflection: {
    enabled: true,
    trigger: { step_count: 25, on_compaction: true },
    merge: "auto",
    category: "quick",
    timeout_minutes: 15,
    sandbox: "auto",
  },
  nudge: { enabled: true, every_user_turns: 10 },
  facts: { enabled: true, debounce_settles: 4 },
  dream: {
    enabled: true,
    idle_minutes: 30,
    min_hours_between: 24,
    shutdown_launch: true,
    auto_select_max: 5,
    auto_select_max_chars: 150000,
  },
  people: { enabled: true, max_entries: 40, max_entry_chars: 200 },
  soul: { edit_notice: true },
  sync: { enabled: true },
  search: { enabled: true },
  compile_warn_tokens: 30000,
  agents: {},
}

describe("OmoMemorySettingsSchema defaults", () => {
  test("#given an empty memory block #when parsed #then the pinned v2 defaults apply", () => {
    // given
    const input = {}

    // when
    const parsed = OmoMemorySettingsSchema.parse(input)

    // then
    expect(parsed).toEqual(FULL_DEFAULTS)
  })

  test("#given a fully specified memory block #when parsed #then every explicit value is preserved", () => {
    // given
    const input: OmoMemorySettings = {
      enabled: false,
      agent: "backend-lead",
      tool_exposure: "search",
      reflection: {
        enabled: false,
        trigger: { step_count: 25, on_compaction: false },
        merge: "integration",
        category: "deep",
        timeout_minutes: 30,
        sandbox: "required",
      },
      nudge: { enabled: false, every_user_turns: 5 },
      facts: { enabled: false, debounce_settles: 2 },
      dream: {
        enabled: false,
        idle_minutes: 0,
        min_hours_between: 12,
        shutdown_launch: false,
        auto_select_max: 3,
        auto_select_max_chars: 100000,
      },
      people: { enabled: false, max_entries: 20, max_entry_chars: 100 },
      soul: { edit_notice: false },
      sync: { remote: "file:///tmp/memory-mirror.git", enabled: true },
      search: { enabled: false },
      compile_warn_tokens: 50000,
      agents: {
        "backend-lead": {
          enabled: true,
          reflection: { trigger: { step_count: 10 }, category: "quick" },
        },
      },
    }

    // when
    const parsed = OmoMemorySettingsSchema.parse(input)

    // then
    expect(parsed).toEqual(input)
  })

  test("#given step_count default #when parsing empty #then reflection step_count defaults to 25", () => {
    // given
    const input = {}

    // when
    const parsed = OmoMemorySettingsSchema.parse(input)

    // then
    expect(parsed.reflection.trigger.step_count).toBe(25)
    expect(parsed.reflection.enabled).toBe(true)
  })

  test("#given an explicit step_count of 0 #when parsed #then 0 is preserved (disables trigger)", () => {
    // given
    const input = { reflection: { trigger: { step_count: 0 } } }

    // when
    const parsed = OmoMemorySettingsSchema.parse(input)

    // then
    expect(parsed.reflection.trigger.step_count).toBe(0)
  })

  test("#given a negative reflection step count #when parsed #then validation fails at the trigger path", () => {
    // given
    const input = { reflection: { trigger: { step_count: -1 } } }

    // when
    const result = OmoMemorySettingsSchema.safeParse(input)

    // then
    expect(result.success).toBe(false)
    if (result.success) throw new Error("Expected memory settings parsing to fail")
    expect(result.error.issues.map((issue) => issue.path.join(".")).join(",")).toContain("reflection.trigger.step_count")
  })

  test("#given a non-boolean compaction trigger #when parsed #then validation fails at the trigger path", () => {
    // given
    const input = { reflection: { trigger: { on_compaction: "yes" } } }

    // when
    const result = OmoMemorySettingsSchema.safeParse(input)

    // then
    expect(result.success).toBe(false)
    if (result.success) throw new Error("Expected memory settings parsing to fail")
    expect(result.error.issues.map((issue) => issue.path.join(".")).join(",")).toContain("reflection.trigger.on_compaction")
  })

  test("#given unknown keys inside the memory block #when parsed #then the strict schema rejects them", () => {
    // given
    const rootUnknown = { enabled: true, bogus: true }
    const nestedUnknown = { reflection: { bogus: true } }

    // when
    const rootResult = OmoMemorySettingsSchema.safeParse(rootUnknown)
    const nestedResult = OmoMemorySettingsSchema.safeParse(nestedUnknown)

    // then
    expect(rootResult.success).toBe(false)
    expect(nestedResult.success).toBe(false)
  })
})

describe("OmoMemorySettingsSchema v2 block defaults", () => {
  test("#given nudge defaults #when parsing empty #then nudge is enabled with every_user_turns 10", () => {
    // given
    const input = {}

    // when
    const parsed = OmoMemorySettingsSchema.parse(input)

    // then
    expect(parsed.nudge).toEqual({ enabled: true, every_user_turns: 10 })
  })

  test("#given nudge every_user_turns below 1 #when parsed #then validation fails", () => {
    // given
    const input = { nudge: { every_user_turns: 0 } }

    // when
    const result = OmoMemorySettingsSchema.safeParse(input)

    // then
    expect(result.success).toBe(false)
  })

  test("#given facts defaults #when parsing empty #then facts is enabled with debounce_settles 4", () => {
    // given
    const input = {}

    // when
    const parsed = OmoMemorySettingsSchema.parse(input)

    // then
    expect(parsed.facts).toEqual({ enabled: true, debounce_settles: 4 })
  })

  test("#given facts with a category field #when parsed #then the strict schema rejects it", () => {
    // given
    const input = { facts: { category: "quick" } }

    // when
    const result = OmoMemorySettingsSchema.safeParse(input)

    // then
    expect(result.success).toBe(false)
  })

  test("#given facts debounce_settles below 1 #when parsed #then validation fails", () => {
    // given
    const input = { facts: { debounce_settles: 0 } }

    // when
    const result = OmoMemorySettingsSchema.safeParse(input)

    // then
    expect(result.success).toBe(false)
  })

  test("#given dream defaults #when parsing empty #then dream is fully populated", () => {
    // given
    const input = {}

    // when
    const parsed = OmoMemorySettingsSchema.parse(input)

    // then
    expect(parsed.dream).toEqual({
      enabled: true,
      idle_minutes: 30,
      min_hours_between: 24,
      shutdown_launch: true,
      auto_select_max: 5,
      auto_select_max_chars: 150000,
    })
  })

  test("#given dream idle_minutes 0 #when parsed #then 0 is allowed (disables idle trigger)", () => {
    // given
    const input = { dream: { idle_minutes: 0 } }

    // when
    const parsed = OmoMemorySettingsSchema.parse(input)

    // then
    expect(parsed.dream.idle_minutes).toBe(0)
  })

  test("#given dream min_hours_between below 1 #when parsed #then validation fails", () => {
    // given
    const input = { dream: { min_hours_between: 0 } }

    // when
    const result = OmoMemorySettingsSchema.safeParse(input)

    // then
    expect(result.success).toBe(false)
  })

  test("#given dream auto_select_max outside 1..10 #when parsed #then validation fails", () => {
    // given
    const tooLow = { dream: { auto_select_max: 0 } }
    const tooHigh = { dream: { auto_select_max: 11 } }

    // when
    const lowResult = OmoMemorySettingsSchema.safeParse(tooLow)
    const highResult = OmoMemorySettingsSchema.safeParse(tooHigh)

    // then
    expect(lowResult.success).toBe(false)
    expect(highResult.success).toBe(false)
  })

  test("#given dream auto_select_max_chars below 10000 #when parsed #then validation fails", () => {
    // given
    const input = { dream: { auto_select_max_chars: 9999 } }

    // when
    const result = OmoMemorySettingsSchema.safeParse(input)

    // then
    expect(result.success).toBe(false)
  })

  test("#given people defaults #when parsing empty #then people is enabled with limits", () => {
    // given
    const input = {}

    // when
    const parsed = OmoMemorySettingsSchema.parse(input)

    // then
    expect(parsed.people).toEqual({ enabled: true, max_entries: 40, max_entry_chars: 200 })
  })

  test("#given people max_entries outside 1..100 #when parsed #then validation fails", () => {
    // given
    const tooLow = { people: { max_entries: 0 } }
    const tooHigh = { people: { max_entries: 101 } }

    // when
    const lowResult = OmoMemorySettingsSchema.safeParse(tooLow)
    const highResult = OmoMemorySettingsSchema.safeParse(tooHigh)

    // then
    expect(lowResult.success).toBe(false)
    expect(highResult.success).toBe(false)
  })

  test("#given people max_entry_chars outside 50..500 #when parsed #then validation fails", () => {
    // given
    const tooLow = { people: { max_entry_chars: 49 } }
    const tooHigh = { people: { max_entry_chars: 501 } }

    // when
    const lowResult = OmoMemorySettingsSchema.safeParse(tooLow)
    const highResult = OmoMemorySettingsSchema.safeParse(tooHigh)

    // then
    expect(lowResult.success).toBe(false)
    expect(highResult.success).toBe(false)
  })

  test("#given soul defaults #when parsing empty #then edit_notice is true", () => {
    // given
    const input = {}

    // when
    const parsed = OmoMemorySettingsSchema.parse(input)

    // then
    expect(parsed.soul).toEqual({ edit_notice: true })
  })

  test("#given soul with an unknown key #when parsed #then the strict schema rejects it", () => {
    // given
    const input = { soul: { bogus: true } }

    // when
    const result = OmoMemorySettingsSchema.safeParse(input)

    // then
    expect(result.success).toBe(false)
  })

  test("#given an unknown key inside any v2 block #when parsed #then the strict schema rejects it", () => {
    // given
    const cases = [
      { nudge: { bogus: true } },
      { facts: { bogus: true } },
      { dream: { bogus: true } },
      { people: { bogus: true } },
    ]

    // when
    const results = cases.map((input) => OmoMemorySettingsSchema.safeParse(input))

    // then
    for (const result of results) {
      expect(result.success).toBe(false)
    }
  })
})

describe("OmoMemorySettingsSchema per-agent overrides", () => {
  test("#given per-agent overrides #when parsed #then they stay default-free deep-partials", () => {
    // given
    const input = {
      agents: {
        "backend-lead": { enabled: false, reflection: { trigger: { step_count: 10 } } },
      },
    }

    // when
    const parsed = OmoMemorySettingsSchema.parse(input)

    // then
    expect(parsed.agents["backend-lead"]).toEqual({
      enabled: false,
      reflection: { trigger: { step_count: 10 } },
    })
  })

  test("#given an unknown key inside an agent override #when parsed #then validation fails", () => {
    // given
    const input = { agents: { "backend-lead": { bogus: true } } }

    // when
    const result = OmoMemorySettingsSchema.safeParse(input)

    // then
    expect(result.success).toBe(false)
  })

  test("#given per-agent dream override #when parsed #then it overrides the base dream block", () => {
    // given
    const input = {
      agents: {
        "research-agent": { dream: { idle_minutes: 60 } },
      },
    }

    // when
    const parsed = OmoMemorySettingsSchema.parse(input)

    // then
    expect(parsed.agents["research-agent"]?.dream).toEqual({ idle_minutes: 60 })
  })

  test("#given per-agent nudge override #when parsed #then it overrides the base nudge block", () => {
    // given
    const input = {
      agents: {
        "research-agent": { nudge: { every_user_turns: 20 } },
      },
    }

    // when
    const parsed = OmoMemorySettingsSchema.parse(input)

    // then
    expect(parsed.agents["research-agent"]?.nudge).toEqual({ every_user_turns: 20 })
  })
})

describe("OmoMemorySettingsLayerSchema", () => {
  test("#given a partial layer block #when parsed #then it remains a default-free deep-partial", () => {
    // given
    const input = { reflection: { category: "deep" } }

    // when
    const parsed = OmoMemorySettingsLayerSchema.parse(input)

    // then
    expect(parsed).toEqual({ reflection: { category: "deep" } })
  })

  test("#given an unknown layer key #when parsed #then the strict layer schema rejects it", () => {
    // given
    const input = { bogus: 1 }

    // when
    const result = OmoMemorySettingsLayerSchema.safeParse(input)

    // then
    expect(result.success).toBe(false)
  })

  test("#given v2 block layer keys #when parsed #then they are accepted as deep-partials", () => {
    // given
    const input = {
      nudge: { every_user_turns: 5 },
      facts: { debounce_settles: 2 },
      dream: { idle_minutes: 0 },
      people: { max_entries: 20 },
      soul: { edit_notice: false },
    }

    // when
    const parsed = OmoMemorySettingsLayerSchema.parse(input)

    // then
    expect(parsed).toEqual(input)
  })
})
