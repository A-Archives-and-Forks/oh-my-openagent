import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { GitMemoryRepo, buildIdentityPaths } from "@oh-my-opencode/memory-core"

import { createMemoryBinding } from "../components/memory/binding"
import { createMemoryIdentityContext } from "../components/memory/context"
import { MemoryFakeExtensionAPI } from "../components/memory/memory.test-support"
import { ACCEPTED_TURNS_ENTRY_TYPE, createMemoryNudgeWiring } from "../components/memory/nudge-wiring"
import { handleMemoryMcpRequest } from "./memory-server"

const roots: string[] = []

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "omo-memory-mcp-"))
  roots.push(root)
  return {
    cwd: join(root, "project"),
    env: { ...process.env, OMO_MEMORY_HOME: join(root, "memory-home") },
  }
}

function body(result: { content?: unknown } | undefined): string {
  const content = result?.content
  if (!Array.isArray(content)) return ""
  return content.map((item) => (item as { text?: string }).text ?? "").join("")
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("omo-memory MCP server", () => {
  test("#given initialize #then server info and tool capabilities are returned", async () => {
    const result = await handleMemoryMcpRequest({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    const payload = result?.result as { serverInfo?: { name?: string }; capabilities?: { tools?: unknown } } | undefined
    expect(payload?.serverInfo?.name).toBe("omo-memory")
    expect(payload?.capabilities?.tools).toBeDefined()
  })

  test("#given tools/list #then exactly the two memory tools are exposed", async () => {
    const result = await handleMemoryMcpRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" })
    const tools = (result?.result as { tools?: { name: string }[] } | undefined)?.tools ?? []
    expect(tools.map((tool) => tool.name)).toEqual(["memory", "memory_apply_patch"])
  })

  test("#given a fresh project #when create then str_replace run through tools/call #then the memory repo records them", async () => {
    const { cwd, env } = fixture()
    const created = await handleMemoryMcpRequest(
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "memory", arguments: {
        command: "create", reason: "Record preference", file_path: "system/human/preferences.md",
        description: "User preferences", file_text: "theme: dark",
      } } },
      { cwd, env },
    )
    expect(body(created?.result as { content?: unknown })).toContain("Memory create committed locally")

    const replaced = await handleMemoryMcpRequest(
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "memory", arguments: {
        command: "str_replace", reason: "Switch theme", file_path: "system/human/preferences.md",
        old_string: "theme: dark", new_string: "theme: light",
      } } },
      { cwd, env },
    )
    expect(body(replaced?.result as { content?: unknown })).toContain("Memory str_replace committed locally")

    const agentsDir = join(String(env.OMO_MEMORY_HOME), "agents")
    const identityDir = readdirSync(agentsDir)[0]
    expect(identityDir).toBeDefined()
    const profile = readFileSync(
      join(agentsDir, String(identityDir), "repo", "system/human/preferences.md"),
      "utf8",
    )
    expect(profile).toContain("theme: light")
  })

  test("#given injected provenance for a non-auto identity #when an MCP memory call runs #then it writes that bound repo with durable turn trailers", async () => {
    // given
    const { cwd, env } = fixture()
    const identityId = "explicit-agent-deadbeef"
    const paths = buildIdentityPaths(String(env.OMO_MEMORY_HOME), identityId)
    const repo = new GitMemoryRepo({ dir: paths.repo, agentId: identityId })
    await repo.init({ installHooks: () => undefined })
    const context = createMemoryIdentityContext({
      identity: identityId,
      identityPaths: paths,
      binding: createMemoryBinding({ identity: identityId, repoPath: paths.repo, boundAt: 1 }),
    })
    const pi = new MemoryFakeExtensionAPI()
    const nudge = createMemoryNudgeWiring({
      resolveContext: () => context,
      resolveSettings: () => ({ enabled: true, everyUserTurns: 2 }),
    })
    nudge.register(pi)
    const eventContext = {
      sessionManager: {
        getSessionId: () => "session-mcp",
        getEntries: () => [{
          type: "custom",
          customType: ACCEPTED_TURNS_ENTRY_TYPE,
          data: { version: 1, sessionId: "session-mcp", priorUserTurns: 3, sessionBaselineTurns: 1 },
        }],
      },
    }
    await pi.dispatch("session_start", {}, eventContext)
    expect(await nudge.nudgeTurns(repo, "session-mcp", identityId)).toBe(2)

    // when
    const result = await handleMemoryMcpRequest(
      { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "memory", arguments: {
        command: "create",
        reason: "Record bound identity",
        file_path: "bound.md",
        description: "Bound",
        provenance: {
          sessionId: "session-mcp",
          userTurns: 3,
          identityId,
          repoPath: paths.repo,
        },
      } } },
      { cwd, env },
    )

    // then
    expect(body(result?.result as { content?: unknown })).toContain("Memory create committed locally")
    expect(await repo.show("HEAD", "bound.md")).toContain("description: Bound")
    expect((await repo.log({ limit: 1 }))[0]?.trailers).toEqual({
      "Omo-Writer": "memory-tool",
      "Omo-Session": "session-mcp",
      "Omo-Turn": "3",
    })
    expect(await nudge.nudgeTurns(repo, "session-mcp", identityId)).toBeUndefined()
    expect(readdirSync(join(String(env.OMO_MEMORY_HOME), "agents"))).toEqual([identityId])
  })

  test("#given an unknown tool name #when called #then an error result is returned", async () => {
    const { cwd, env } = fixture()
    const result = await handleMemoryMcpRequest(
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "nope", arguments: {} } },
      { cwd, env },
    )
    expect((result?.result as { isError?: boolean } | undefined)?.isError).toBe(true)
  })
})
