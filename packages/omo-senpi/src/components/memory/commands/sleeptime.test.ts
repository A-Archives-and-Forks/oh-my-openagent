import { afterEach, describe, expect, test } from "bun:test"
import { rm } from "node:fs/promises"

import { MemoryFakeExtensionAPI, memorySettings } from "../memory.test-support"
import { TEST_IDENTITY, fakeCommandContext, fakeDeps, invoke, tempIdentity } from "./commands.test-support"
import { registerSleeptimeCommand, resolveSleeptimeSettings } from "./sleeptime"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })))
})

describe("/sleeptime", () => {
  test("#given default settings #when resolved and invoked #then machine values use their defaults without override flags", async () => {
    // given
    const { root, identity } = await tempIdentity()
    tempDirs.push(root)
    const settings = memorySettings()
    const pi = new MemoryFakeExtensionAPI()
    registerSleeptimeCommand(pi, fakeDeps(identity, { loadSettings: () => ({ settings, configPath: "/tmp/omo.jsonc" }) }))
    const ctx = fakeCommandContext()

    // when
    const resolved = resolveSleeptimeSettings(settings, TEST_IDENTITY)
    const text = await invoke(pi, "sleeptime", "", ctx)

    // then
    expect(resolved).toEqual({
      reflection: {
        stepCount: { value: 25, overridden: false },
        onCompaction: { value: true, overridden: false },
        merge: { value: "auto", overridden: false },
        category: { value: "quick", overridden: false },
        timeoutMinutes: { value: 15, overridden: false },
        sandbox: { value: "auto", overridden: false },
      },
      nudge: {
        enabled: { value: true, overridden: false },
        everyUserTurns: { value: 10, overridden: false },
      },
      facts: {
        enabled: { value: true, overridden: false },
        debounceSettles: { value: 4, overridden: false },
      },
      dream: {
        enabled: { value: true, overridden: false },
        idleMinutes: { value: 30, overridden: false },
        minHoursBetween: { value: 24, overridden: false },
        shutdownLaunch: { value: true, overridden: false },
        autoSelectMax: { value: 5, overridden: false },
      },
      people: {
        enabled: { value: true, overridden: false },
        maxEntries: { value: 40, overridden: false },
        maxEntryChars: { value: 200, overridden: false },
      },
      soul: { editNotice: { value: true, overridden: false } },
    })
    expect(ctx.ui.notifications).toEqual([{ message: text, level: "info" }])
  })

  test("#given per-agent overrides #when resolved and invoked #then override values and flags win field by field", async () => {
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
    const resolved = resolveSleeptimeSettings(settings, TEST_IDENTITY)
    const text = await invoke(pi, "sleeptime", "", ctx)

    // then
    expect(resolved).toEqual({
      reflection: {
        stepCount: { value: 5, overridden: true },
        onCompaction: { value: true, overridden: false },
        merge: { value: "integration", overridden: true },
        category: { value: "quick", overridden: false },
        timeoutMinutes: { value: 30, overridden: true },
        sandbox: { value: "auto", overridden: false },
      },
      nudge: {
        enabled: { value: false, overridden: true },
        everyUserTurns: { value: 20, overridden: true },
      },
      facts: {
        enabled: { value: false, overridden: true },
        debounceSettles: { value: 8, overridden: true },
      },
      dream: {
        enabled: { value: false, overridden: true },
        idleMinutes: { value: 60, overridden: true },
        minHoursBetween: { value: 48, overridden: true },
        shutdownLaunch: { value: true, overridden: false },
        autoSelectMax: { value: 5, overridden: false },
      },
      people: {
        enabled: { value: false, overridden: true },
        maxEntries: { value: 20, overridden: true },
        maxEntryChars: { value: 100, overridden: true },
      },
      soul: { editNotice: { value: false, overridden: true } },
    })
    expect(ctx.ui.notifications).toEqual([{ message: text, level: "info" }])
  })

  test("#given an unbound session #when invoked #then the command surfaces a structured error notification", async () => {
    // given
    const pi = new MemoryFakeExtensionAPI()
    registerSleeptimeCommand(pi, fakeDeps(undefined))
    const ctx = fakeCommandContext()

    // when
    const text = await invoke(pi, "sleeptime", "", ctx)

    // then
    expect(ctx.ui.notifications).toEqual([{ message: text, level: "error" }])
  })
})
