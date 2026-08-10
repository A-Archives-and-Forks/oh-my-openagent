import { describe, expect, test } from "bun:test"

import type { SenpiExtensionAPI } from "../../extension/types"
import { MEMORY_MCP_SERVER_NAME, registerMemoryToolSurface } from "./tools"

function fakeApi(overrides: Partial<SenpiExtensionAPI> = {}) {
  const tools: string[] = []
  const mcpServers: Array<{ name: string; config: Record<string, unknown> }> = []
  const api = {
    registerTool: (tool: { name: string }) => { tools.push(tool.name) },
    ...overrides,
  } as unknown as SenpiExtensionAPI
  return { api, tools, mcpServers }
}

describe("registerMemoryToolSurface", () => {
  describe("#given a host with registerMcpServer", () => {
    test("#when the surface registers #then the memory tools go through an exposure-search MCP server", () => {
      const mcpServers: Array<{ name: string; config: Record<string, unknown> }> = []
      const api = {
        registerTool: () => { throw new Error("direct registration must not run") },
        registerMcpServer: (name: string, config: Record<string, unknown>) => { mcpServers.push({ name, config }) },
      } as unknown as SenpiExtensionAPI

      registerMemoryToolSurface(api, () => undefined)

      expect(mcpServers).toHaveLength(1)
      const [server] = mcpServers
      expect(server?.name).toBe(MEMORY_MCP_SERVER_NAME)
      expect(server?.config["exposure"]).toBe("search")
      expect(server?.config["command"]).toBe(process.execPath)
      expect(String((server?.config["args"] as string[])[0])).toEndWith("omo-memory-mcp.js")
    })
  })

  describe("#given a host without registerMcpServer", () => {
    test("#when the surface registers #then both tools register directly as the fallback", () => {
      const { api, tools } = fakeApi()
      registerMemoryToolSurface(api, () => undefined)
      expect(tools).toEqual(["memory", "memory_apply_patch"])
    })
  })
})
