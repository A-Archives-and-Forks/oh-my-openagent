import { afterEach, describe, expect, test } from "bun:test"
import { rm } from "node:fs/promises"

import { MemoryFakeExtensionAPI, memorySettings } from "../memory.test-support"
import { TEST_IDENTITY, fakeCommandContext, fakeDeps, invoke, tempIdentity } from "./commands.test-support"
import { registerSleeptimeCommand } from "./sleeptime"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("/sleeptime", () => {
  test("#given default settings #when invoked #then resolved reflection, nudge, facts, dream, people, soul settings, the config path, and the reflect and dream hints render", async () => {
    // given
    const { root, identity } = await tempIdentity()
    tempDirs.push(root)
    const pi = new MemoryFakeExtensionAPI()
    registerSleeptimeCommand(pi, fakeDeps(identity))
    const ctx = fakeCommandContext()

    // when
    const text = await invoke(pi, "sleeptime", "", ctx)

    // then -- reflection block
    expect(text).toContain("Step trigger: every 25 steps")
    expect(text).toContain("On compaction: on")
    expect(text).toContain("Merge policy: auto")
    expect(text).toContain("Category: quick")
    expect(text).toContain("Timeout: 15 minutes")
    expect(text).toContain("Sandbox: auto")
    // then -- nudge block
    expect(text).toContain("Nudge: on")
    expect(text).toContain("every 10 turns")
    // then -- facts block
    expect(text).toContain("Facts: on")
    expect(text).toContain("debounce 4 settles")
    // then -- dream block
    expect(text).toContain("Dream: on")
    expect(text).toContain("idle 30 minutes")
    expect(text).toContain("min 24h between")
    expect(text).toContain("shutdown launch on")
    expect(text).toContain("select max 5")
    // then -- people block
    expect(text).toContain("People: on")
    expect(text).toContain("max 40 entries")
    expect(text).toContain("max 200 chars")
    // then -- soul block
    expect(text).toContain("Soul: edit notice on")
    // then -- hints
    expect(text).toContain("/tmp/omo.jsonc")
    expect(text).toContain("memory.reflection")
    expect(text).toContain("/reflect")
    expect(text).toContain("/dream")
    expect(ctx.ui.notifications.at(-1)?.level).toBe("info")
  })

  test("#given per-agent overrides on reflection, nudge, facts, dream, people, soul #when invoked #then overridden fields are marked and applied", async () => {
    // given
    const { root, identity } = await tempIdentity()
    tempDirs.push(root)
    const settings = memorySettings({
      agents: {
        [TEST_IDENTITY]: {
          reflection: { trigger: { step_count: 5 }, merge: "integration", timeout_minutes: 30 },
          nudge: { enabled: false, every_user_turns: 20 },
          facts: { enabled: false, debounce_settles: 8 },
          dream: { enabled: false, idle_minutes: 60, min_hours_between: 48 },
          people: { enabled: false, max_entries: 20, max_entry_chars: 100 },
          soul: { edit_notice: false },
        },
      },
    })
    const pi = new MemoryFakeExtensionAPI()
    registerSleeptimeCommand(pi, fakeDeps(identity, { loadSettings: () => ({ settings, configPath: "/tmp/omo.jsonc" }) }))
    const ctx = fakeCommandContext()

    // when
    const text = await invoke(pi, "sleeptime", "", ctx)

    // then -- reflection overrides
    expect(text).toContain("Step trigger: every 5 steps [agent override]")
    expect(text).toContain("Merge policy: integration [agent override]")
    expect(text).toContain("Timeout: 30 minutes [agent override]")
    expect(text).toContain("Category: quick")
    // then -- nudge overrides
    expect(text).toContain("Nudge: off [agent override]")
    expect(text).toContain("every 20 turns [agent override]")
    // then -- facts overrides
    expect(text).toContain("Facts: off [agent override]")
    expect(text).toContain("debounce 8 settles [agent override]")
    // then -- dream overrides
    expect(text).toContain("Dream: off [agent override]")
    expect(text).toContain("idle 60 minutes [agent override]")
    expect(text).toContain("min 48h between [agent override]")
    // then -- people overrides
    expect(text).toContain("People: off [agent override]")
    expect(text).toContain("max 20 entries [agent override]")
    expect(text).toContain("max 100 chars [agent override]")
    // then -- soul overrides
    expect(text).toContain("Soul: edit notice off [agent override]")
    // then -- config hint references per-agent path
    expect(text).toContain(`memory.agents.${TEST_IDENTITY}`)
  })

  test("#given an unbound session #when invoked #then an actionable error is returned", async () => {
    // given
    const pi = new MemoryFakeExtensionAPI()
    registerSleeptimeCommand(pi, fakeDeps(undefined))
    const ctx = fakeCommandContext()

    // when
    const text = await invoke(pi, "sleeptime", "", ctx)

    // then
    expect(text).toContain("not bound")
    expect(ctx.ui.notifications.at(-1)?.level).toBe("error")
  })
})
