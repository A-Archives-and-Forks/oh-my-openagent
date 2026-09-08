import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import { _resetForTesting, setMainSession, subagentSessions } from "../../features/claude-code-session-state"
import { resolveUltraworkOverride } from "../../plugin/ultrawork-model-override"
import { stopContinuation } from "../../plugin/stop-continuation"
import { createEventHookDispatcher, createEventHookRunner } from "../../plugin/event-hook-dispatcher"
import { createKeywordDetectorHook } from "./hook"

let hook: ReturnType<typeof createKeywordDetectorHook>
const config = { agents: { sisyphus: { ultrawork: { model: "test/ulw-model" } } } }

async function send(text: string, sessionID = "main-session", agent = "sisyphus", synthetic = false) {
  const output = { message: {}, parts: [{ type: "text", text, synthetic }] }
  await hook["chat.message"]({ sessionID, agent }, output)
  return {
    active: output.parts[0].text.includes("<ultrawork-mode>"),
    override: resolveUltraworkOverride(config, agent, output, sessionID),
  }
}

beforeEach(() => {
  _resetForTesting()
  setMainSession("main-session")
  hook = createKeywordDetectorHook(unsafeTestValue<PluginInput>({
    client: { tui: { showToast: async () => {} } },
  }))
})
afterEach(() => {
  hook.dispose()
  _resetForTesting()
})

describe("explicit ULW session follow-ups", () => {
  test("#given explicit activation #when a follow-up has no keyword #then injection and model selection persist only in that session", async () => {
    expect((await send("ulw implement auth")).active).toBe(true)
    expect(await send("and add error handling")).toEqual({
      active: true, override: { providerID: "test", modelID: "ulw-model", variant: undefined },
    })
    expect(await send("unrelated request", "other-session")).toEqual({ active: false, override: null })
  })

  test.each(["command", "owner", "deleted", "disposed"])("#given activation #when cleared by %s #then follow-ups are ordinary", async (reason) => {
    await send("ulw implement auth")
    if (reason === "command") await send("/stop-continuation")
    if (reason === "owner") {
      const directory = mkdtempSync(join(tmpdir(), "ulw-followup-"))
      try {
        stopContinuation({ directory, hooks: { keywordDetector: hook }, sessionID: "main-session" })
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    }
    if (reason === "deleted") {
      const dispatch = createEventHookDispatcher(
        unsafeTestValue<Parameters<typeof createEventHookDispatcher>[0]>({ keywordDetector: hook }),
        createEventHookRunner(),
      )
      await dispatch({ event: { type: "session.deleted", properties: { info: { id: "main-session" } } } })
    }
    if (reason === "disposed") hook.dispose()
    expect(await send("next request")).toEqual({ active: false, override: null })
  })

  test("#given activation #when a follow-up is guarded #then no ULW is injected", async () => {
    await send("ulw implement auth")
    expect((await send("internal request", "main-session", "sisyphus", true)).active).toBe(false)
    expect((await send("plan a change", "main-session", "prometheus")).active).toBe(false)
    subagentSessions.add("main-session")
    expect((await send("background request")).active).toBe(false)
    subagentSessions.delete("main-session")
    expect((await send("real follow-up")).active).toBe(true)
  })

  test("#given more than the session cap #when checking follow-ups #then oldest activation is evicted", async () => {
    for (let i = 0; i <= 256; i++) await send("ulw implement auth", `session-${i}`)
    expect((await send("next request", "session-0")).active).toBe(false)
    expect((await send("next request", "session-256")).active).toBe(true)
  })
})
