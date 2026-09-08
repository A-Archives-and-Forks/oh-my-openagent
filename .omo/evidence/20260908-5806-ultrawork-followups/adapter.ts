import { appendFileSync, renameSync, writeFileSync } from "node:fs"
import { createKeywordDetectorHook } from "../../../packages/omo-opencode/src/hooks/keyword-detector/hook"
import { resolveUltraworkOverride } from "../../../packages/omo-opencode/src/plugin/ultrawork-model-override"
import { stopContinuation } from "../../../packages/omo-opencode/src/plugin/stop-continuation"
import { createEventHookDispatcher, createEventHookRunner } from "../../../packages/omo-opencode/src/plugin/event-hook-dispatcher"
import { resolveSessionEventID } from "../../../packages/omo-opencode/src/shared/event-session-id"
import { unsafeTestValue } from "../../../test-support/unsafe-test-value"
import type { PluginInput } from "@opencode-ai/plugin"

export default {
  id: "qa-ulw-followup",
  async server(ctx: PluginInput) {
    writeFileSync("/qa/factory.json", JSON.stringify({ directory: ctx.directory }))
    const hook = createKeywordDetectorHook(ctx)
    const routedEvents = new Set<string>()
    const safe = createEventHookRunner()
    const dispatch = createEventHookDispatcher(
      unsafeTestValue<Parameters<typeof createEventHookDispatcher>[0]>({ keywordDetector: hook }),
      async (name, handler, input) => {
        if (name === "keywordDetector" && handler) routedEvents.add(input.event.type)
        await safe(name, handler, input)
      },
    )
    return {
      ...hook,
      event: async (input: Parameters<typeof dispatch>[0]) => {
        await dispatch(input)
        if (input.event.type === "session.deleted") {
          const sessionID = resolveSessionEventID(input.event.properties)
          if (!sessionID) throw new Error("Missing deleted session id")
          const probe = { message: {}, parts: [{ type: "text", text: "ordinary request" }] }
          await hook["chat.message"]({ sessionID, agent: "sisyphus" }, probe)
          const receipt = { routed: routedEvents.has("session.deleted"), cleared: !probe.parts[0].text.includes("<ultrawork-mode>") }
          writeFileSync("/qa/deletion.json.tmp", JSON.stringify(receipt))
          renameSync("/qa/deletion.json.tmp", "/qa/deletion.json")
        }
      },
      "command.execute.before": async (input: { command: string; sessionID: string }) => {
        if (input.command === "stop-continuation") {
          stopContinuation({ directory: ctx.directory, hooks: { keywordDetector: hook }, sessionID: input.sessionID })
        }
      },
      "chat.message": async (
        input: Parameters<typeof hook["chat.message"]>[0],
        output: Parameters<typeof hook["chat.message"]>[1],
      ) => {
        await hook["chat.message"](input, output)
        const active = output.parts.some(part => part.text?.includes("<ultrawork-mode>"))
        const override = resolveUltraworkOverride({
          agents: { sisyphus: { ultrawork: { model: "qa/ulw-selected" } } },
        }, input.agent, output, input.sessionID)
        appendFileSync("/qa/calls.jsonl", JSON.stringify({ active, override }) + "\n")
      },
    }
  },
}
