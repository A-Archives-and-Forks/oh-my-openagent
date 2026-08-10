import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { buildIdentityPaths } from "@oh-my-opencode/memory-core"

import { MemoryFakeExtensionAPI, componentContext, loadedMemoryConfig, memorySettings } from "./memory.test-support"
import { createMemoryIdentityContext } from "./context"
import type { MemoryIdentityRuntime } from "./identity-runtime"
import { createMemoryWiring } from "./wiring"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(settings: ReturnType<typeof memorySettings> | undefined): Promise<{
  readonly pi: MemoryFakeExtensionAPI
  readonly evaluations: { count: number }
}> {
  const root = await mkdtemp(join(tmpdir(), "omo-memory-wiring-"))
  roots.push(root)
  const identity = createMemoryIdentityContext({
    identity: "agent-test",
    identityPaths: buildIdentityPaths(root, "agent-test"),
    binding: { identity: "agent-test", repoPathHash: "hash", boundAt: 1 },
  })
  const sessions = new Map([["session-1", { context: identity }]])
  const evaluations = { count: 0 }
  const runtime = {
    store: {
      evaluate: async () => {
        evaluations.count += 1
        return null
      },
    },
    launch: () => {},
  } as unknown as MemoryIdentityRuntime
  const pi = new MemoryFakeExtensionAPI()
  createMemoryWiring({
    sessions,
    loadConfig: () => settings === undefined
      ? { config: {}, diagnostics: [], layers: [], sources: [] }
      : loadedMemoryConfig(settings),
    cwd: () => root,
    env: {},
    createRuntime: () => runtime,
  }).registerStatic(pi, componentContext())
  return { pi, evaluations }
}

const eventCtx = {
  sessionManager: {
    getSessionId: () => "session-1",
    getEntries: () => [],
  },
}

describe("memory wiring reflection policy", () => {
  test("#given reflection disabled for the bound agent #when an automatic settle arrives #then no reservation evaluation starts", async () => {
    const settings = memorySettings()
    settings.agents["agent-test"] = { reflection: { enabled: false } }
    const { pi, evaluations } = await fixture(settings)

    await pi.dispatch("agent_end", { aborted: false, willRetry: false }, eventCtx)
    await pi.dispatch("agent_settled", {}, eventCtx)

    expect(evaluations.count).toBe(0)
  })

  test("#given the memory block is absent #when an automatic settle arrives #then schema-default reflection remains enabled", async () => {
    const { pi, evaluations } = await fixture(undefined)

    await pi.dispatch("agent_end", { aborted: false, willRetry: false }, eventCtx)
    await pi.dispatch("agent_settled", {}, eventCtx)

    expect(evaluations.count).toBe(1)
  })
})
