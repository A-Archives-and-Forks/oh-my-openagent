import { afterEach, beforeAll, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { buildMigrationRuntime } from "../../../script/build-migration-runtime"
import { teardownRoots } from "./teardown.test-support"

const roots: string[] = []
const launcher = fileURLToPath(new URL("../bin/omo.js", import.meta.url))
beforeAll(buildMigrationRuntime)
afterEach(() => teardownRoots(roots))
function write(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value))
}
function json(path: string) {
  return JSON.parse(readFileSync(path, "utf8"))
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "omo-source-compatibility-"))
  roots.push(root)
  const home = join(root, "home")
  const agent = join(root, "agent")
  const config = join(root, "config", "opencode")
  const data = join(root, "data", "opencode")
  mkdirSync(home)
  return { root, home, agent, config, data }
}
function run(item: ReturnType<typeof fixture>, command = "migrate") {
  return spawnSync(process.execPath, [launcher, command, "--yes"], {
    encoding: "utf8", cwd: item.home,
    env: {
      PATH: process.env.PATH, HOME: item.home, USERPROFILE: item.home,
      OMO_CODING_AGENT_DIR: item.agent, SENPI_CODING_AGENT_DIR: item.agent, PI_CODING_AGENT_DIR: item.agent,
      XDG_CONFIG_HOME: dirname(item.config), XDG_DATA_HOME: dirname(item.data),
      XDG_STATE_HOME: join(item.root, "state"), XDG_CACHE_HOME: join(item.root, "cache"),
    },
  })
}

test.each(["setup", "migrate"])("#given all global config layers #when %s runs #then JSONC overrides while retaining other layers", (command) => {
  const item = fixture()
  write(join(item.config, "config.json"), { mcp: { legacy: { type: "remote", url: "https://legacy.test/mcp" } } })
  write(join(item.config, "opencode.json"), { model: "openai/gpt-5", mcp: { json: { type: "remote", url: "https://json.test/mcp" } } })
  write(join(item.config, "opencode.jsonc"), {
    model: "anthropic/claude-opus-4-5", permission: "deny",
    mcp: { jsonc: { type: "remote", url: "https://jsonc.test/mcp" } },
  })

  const result = run(item, command)

  expect(result.status, result.stderr).toBe(0)
  expect(Object.keys(json(join(item.agent, "mcp.json")).mcpServers).sort()).toEqual(["json", "jsonc", "legacy"])
  if (command === "migrate") {
    expect(json(join(item.agent, "settings.json"))).toMatchObject({
      defaultProvider: "anthropic", defaultModel: "claude-opus-4-5", permission: { "*": "deny" },
    })
  }
})

test("#given both TUI config files #when migrating #then keybindings merge with JSONC precedence", () => {
  const item = fixture()
  write(join(item.config, "tui.json"), { keybinds: { session_new: "ctrl+n", model_list: "ctrl+l" } })
  write(join(item.config, "tui.jsonc"), { keybinds: { model_list: "ctrl+m", app_exit: "none" } })
  const result = run(item)
  expect(result.status).toBe(0)
  expect(json(join(item.agent, "keybindings.json"))).toMatchObject({
    "app.session.new": "ctrl+n", "app.model.select": "ctrl+m", "app.exit": [],
  })
})

test.each([
  ["setup", "existing"], ["migrate", "existing"], ["setup", "planned"], ["migrate", "planned"],
])("#given a schema-invalid %s MCP %s document #when applying #then nothing is written", (command, kind) => {
  const item = fixture()
  write(join(item.data, "auth.json"), { openai: { type: "api", key: "DUMMY" } })
  write(join(item.config, "opencode.json"), {
    model: "openai/gpt-5",
    mcp: { remote: { type: "remote", url: "https://example.test/mcp", ...(kind === "planned" ? { headers: { Authorization: 42 } } : {}) } },
  })
  if (kind === "existing") write(join(item.agent, "mcp.json"), { mcpServers: { broken: { type: "http" } } })

  const result = run(item, command)

  expect(result.status).toBe(1)
  expect(existsSync(join(item.agent, "auth.json"))).toBe(false)
  expect(existsSync(join(item.agent, "settings.json"))).toBe(false)
  if (kind === "existing") expect(json(join(item.agent, "mcp.json"))).toEqual({ mcpServers: { broken: { type: "http" } } })
  else expect(existsSync(join(item.agent, "mcp.json"))).toBe(false)
})

test.each(["setup", "migrate"])("#given a literal native variable expression #when %s runs #then that MCP server requires manual review", (command) => {
  const item = fixture()
  write(join(item.config, "opencode.json"), {
    mcp: { remote: { type: "remote", url: "https://example.test/mcp", headers: { Authorization: "Bearer ${OPENAI_API_KEY}" } } },
  })
  const result = run(item, command)
  expect(result.status).toBe(0)
  expect(existsSync(join(item.agent, "mcp.json"))).toBe(false)
  expect(result.stdout).toContain("remote")
})

test("#given nested Markdown agents #when migrating #then relative names and backup sources are retained", () => {
  const item = fixture()
  const source = join(item.config, "agents", "team", "reviewer.md")
  write(source, "---\ndescription: Nested reviewer\n---\nReview nested code.\n")
  const result = run(item)
  expect(result.status).toBe(0)
  const target = join(item.home, ".omo", "omo.jsonc")
  expect(existsSync(target)).toBe(true)
  expect(json(target).agents["team/reviewer"].prompt).toBe("Review nested code.")
  const backup = readdirSync(item.agent).find((name) => name.startsWith("migration-backup-"))
  if (backup === undefined) throw new Error("backup missing")
  const manifest = json(join(item.agent, backup, "manifest.json"))
  expect(manifest.files.some((entry: { path: string }) => entry.path === source)).toBe(true)
})

test("#given a symlinked agent directory #when migrating #then its relative agent names survive", () => {
  const item = fixture()
  const shared = join(item.root, "shared-agents")
  write(join(shared, "reviewer.md"), "---\ndescription: Linked reviewer\n---\nReview linked code.\n")
  mkdirSync(join(item.config, "agents"), { recursive: true })
  symlinkSync(shared, join(item.config, "agents", "team"), "junction")
  const result = run(item)
  expect(result.status).toBe(0)
  const target = join(item.home, ".omo", "omo.jsonc")
  expect(existsSync(target)).toBe(true)
  expect(json(target).agents["team/reviewer"].prompt).toBe("Review linked code.")
})

test("#given inline restrictions and same-name Markdown #when migrating #then missing fields and restrictions are not lost", () => {
  const item = fixture()
  write(join(item.config, "opencode.json"), {
    agent: { reviewer: { model: "openai/gpt-5", permission: { edit: "deny" } } },
  })
  write(join(item.config, "agents", "reviewer.md"), "---\ndescription: Markdown reviewer\n---\nReview carefully.\n")
  const result = run(item)
  expect(result.status).toBe(0)
  expect(json(join(item.home, ".omo", "omo.jsonc")).agents.reviewer).toMatchObject({
    model: "openai/gpt-5", prompt: "Review carefully.", disable: true,
  })
})

test("#given unsupported root and provider options #when migrating #then every omitted key is recorded without its value", () => {
  const item = fixture()
  write(join(item.config, "opencode.json"), {
    model: "{env:MODEL_NAME}", default_agent: "reviewer", instructions: ["RULES.md"],
    provider: { custom: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "https://example.test/v1", headers: { Authorization: "SECRET_SENTINEL" } }, models: { m: {} } } },
  })
  const result = run(item)
  expect(result.status).toBe(0)
  const warnings: string[] = json(join(item.agent, "opencode-migration-report.json")).warnings
  expect(warnings.some((entry) => entry.startsWith("settings.model "))).toBe(true)
  for (const key of ["default_agent", "instructions", "options.headers"]) expect(warnings.some((entry) => entry.includes(key))).toBe(true)
  expect(result.stdout + JSON.stringify(warnings)).not.toContain("SECRET_SENTINEL")
})
