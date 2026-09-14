import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { mockProviderSource } from "./omo-native-telemetry-qa.mjs"

const engineEntry = import.meta.resolve("@code-yeongyu/senpi")
const { toJsonEvent } = await import(new URL("./modes/json-event.js", engineEntry).href)

const roots = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe("telemetry provider RPC serialization", () => {
  test("#given the generated provider #when it streams a tool call #then the real serializer preserves its identity", async () => {
    const root = mkdtempSync(join(tmpdir(), "telemetry-provider-test-"))
    roots.push(root)
    const path = join(root, "provider.mjs")
    writeFileSync(path, mockProviderSource())
    const { default: register } = await import(pathToFileURL(path).href)
    let provider
    register({ registerProvider(_name, value) { provider = value } })
    const stream = provider.streamSimple({}, { messages: [] }, {})
    const events = []
    for await (const event of stream) {
      if (event.type === "toolcall_start") {
        events.push(toJsonEvent({ type: "message_update", message: event.partial, assistantMessageEvent: event }))
      }
    }
    expect(events).toHaveLength(1)
    expect(events[0].assistantMessageEvent).toMatchObject({ type: "toolcall_start", id: "telemetry-qa-tool-1", toolName: "create_goal" })
  })
})
