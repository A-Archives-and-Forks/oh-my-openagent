import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { FakeExtensionAPI } from "../../../test-support/fake-extension-api"
import {
  OMO_NATIVE_PROPERTY_ALLOWLISTS,
  type OmoNativeEventName,
} from "./product-identity"
import { registerOmoNativeToolTelemetry } from "./omo-native-tools"

type CapturedEvent = { readonly name: OmoNativeEventName; readonly properties: Readonly<Record<string, unknown>> }

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(): {
  readonly pi: FakeExtensionAPI
  readonly events: CapturedEvent[]
  readonly diagnostics: string[]
  readonly skillsRoot: string
} {
  const root = mkdtempSync(join(tmpdir(), "omo-native-tools-"))
  temporaryRoots.push(root)
  const skillsRoot = join(root, "plugin", "skills")
  mkdirSync(skillsRoot, { recursive: true })
  const pi = new FakeExtensionAPI()
  const events: CapturedEvent[] = []
  const diagnostics: string[] = []
  registerOmoNativeToolTelemetry(pi, {
    captureEvent: (name, properties) => events.push({ name, properties }),
    diagnostics: (message) => diagnostics.push(message),
    hashSessionId: (sessionId) => `hashed:${sessionId}`,
    skillsRoot,
  })
  return { pi, events, diagnostics, skillsRoot }
}

function context(sessionId = "session-a", cwd?: string): Record<string, unknown> {
  return {
    ...(cwd === undefined ? {} : { cwd }),
    sessionManager: { getSessionId: () => sessionId },
  }
}

function result(toolName: string, input?: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "tool_result",
    toolCallId: "call-1",
    toolName,
    ...(input === undefined ? {} : { input }),
    content: [],
    isError: false,
    details: undefined,
  }
}

function createSkill(skillsRoot: string, name: string): string {
  const directory = join(skillsRoot, name)
  mkdirSync(directory, { recursive: true })
  const path = join(directory, "SKILL.md")
  writeFileSync(path, `# ${name}\n`)
  return path
}

function eventProperties(events: readonly CapturedEvent[], name: OmoNativeEventName): Readonly<Record<string, unknown>>[] {
  return events.filter((event) => event.name === name).map((event) => event.properties)
}

describe("OmO Native tool telemetry", () => {
  test("#given a builtin SKILL.md #when a namespaced Read result arrives #then the exact builtin skill is emitted", async () => {
    const { pi, events, skillsRoot } = fixture()
    const path = createSkill(skillsRoot, "ulw-plan")

    await pi.dispatch("tool_result", result("builtin:Read", { path }), context())

    expect(events).toEqual([{ name: "skill_loaded", properties: { $session_id: "hashed:session-a", skill_name: "ulw-plan" } }])
  })

  test("#given outside, custom, traversal, symlink, and injected skill paths #when read results arrive #then no skill name is emitted", async () => {
    const { pi, events, skillsRoot } = fixture()
    const outsideRoot = join(skillsRoot, "..", "..", "notes")
    const outside = createSkill(outsideRoot, "ulw-plan")
    const custom = createSkill(skillsRoot, "private-skill")
    const injected = createSkill(skillsRoot, 'ulw-plan\"},\"feature\":\"goal_tool')
    const symlinkPath = join(skillsRoot, "debugging")
    symlinkSync(join(outsideRoot, "ulw-plan"), symlinkPath)

    for (const path of [outside, custom, injected, join(skillsRoot, "..", "..", "etc", "passwd"), join(symlinkPath, "SKILL.md")]) {
      await pi.dispatch("tool_result", result("read", { path }), context())
    }
    await pi.dispatch("tool_result", result("read", { path: null }), context())

    expect(events).toEqual([])
  })

  test("#given a background category batch of three #when task completes #then every item uses the batch bucket", async () => {
    const { pi, events } = fixture()

    await pi.dispatch("tool_result", result("omo/task", {
      category: "deep",
      run_in_background: true,
      tasks: [{ prompt: "one" }, { prompt: "two" }, { prompt: "three" }],
    }), context())

    expect(eventProperties(events, "delegation_started")).toEqual([
      { $session_id: "hashed:session-a", kind: "category", name: "deep", background: true, batch_size_bucket: "2_4" },
      { $session_id: "hashed:session-a", kind: "category", name: "deep", background: true, batch_size_bucket: "2_4" },
      { $session_id: "hashed:session-a", kind: "category", name: "deep", background: true, batch_size_bucket: "2_4" },
    ])
  })

  test("#given subagent and unknown category spawns #when task completes #then allowlisted names pass and unknown names are custom", async () => {
    const { pi, events } = fixture()

    await pi.dispatch("tool_result", result("task", { prompt: "scan", subagent_type: "explore" }), context())
    await pi.dispatch("tool_result", result("task", { prompt: "invent", category: "deep-injected" }), context())

    expect(eventProperties(events, "delegation_started")).toEqual([
      { $session_id: "hashed:session-a", kind: "subagent", name: "explore", background: false, batch_size_bucket: "1" },
      { $session_id: "hashed:session-a", kind: "category", name: "custom", background: false, batch_size_bucket: "1" },
    ])
  })

  test("#given feature tools across two sessions #when repeated #then each feature emits once per session", async () => {
    const { pi, events } = fixture()
    const tools = ["create_goal", "team_create", "memory", "memory_apply_patch"]

    for (const toolName of tools) await pi.dispatch("tool_result", result(toolName, {}), context("session-a"))
    for (const toolName of tools) await pi.dispatch("tool_result", result(toolName, {}), context("session-a"))
    await pi.dispatch("tool_result", result("create_goal", {}), context("session-b"))

    expect(eventProperties(events, "feature_used")).toEqual([
      { $session_id: "hashed:session-a", feature: "goal_tool" },
      { $session_id: "hashed:session-a", feature: "team_create" },
      { $session_id: "hashed:session-a", feature: "memory_tool" },
      { $session_id: "hashed:session-b", feature: "goal_tool" },
    ])
  })

  test("#given a session shutdown #when the same id starts using features again #then stale dedup state is cleared", async () => {
    const { pi, events } = fixture()

    await pi.dispatch("tool_result", result("create_goal", {}), context())
    await pi.dispatch("session_shutdown", {}, context())
    await pi.dispatch("tool_result", result("create_goal", {}), context())

    expect(eventProperties(events, "feature_used")).toHaveLength(2)
  })

  test("#given tool_result without input #when handled #then it is ignored with a diagnostic", async () => {
    const { pi, events, diagnostics } = fixture()

    await expect(pi.dispatch("tool_result", result("read"), context())).resolves.toEqual([undefined])

    expect(events).toEqual([])
    expect(diagnostics).toEqual(["omo-native tool_result missing input"])
  })

  test("#given all tool telemetry events #when captured #then payload keys exactly match the product allowlists", async () => {
    const { pi, events, skillsRoot } = fixture()
    const path = createSkill(skillsRoot, "debugging")

    await pi.dispatch("tool_result", result("read", { path }), context())
    await pi.dispatch("tool_result", result("task", { prompt: "scan", subagent_type: "explore" }), context())
    await pi.dispatch("tool_result", result("create_goal", {}), context())

    for (const event of events) {
      expect(Object.keys(event.properties).sort()).toEqual([...OMO_NATIVE_PROPERTY_ALLOWLISTS[event.name]].sort())
    }
  })
})
