import { afterEach, beforeAll, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { ModelConfig } from "../../../node_modules/@code-yeongyu/senpi/dist/core/model-config.js"
import { buildMigrationRuntime } from "../../../script/build-migration-runtime"
import { loadOmoConfig } from "../../omo-config-core/src/index"
import { teardownRoots } from "./teardown.test-support"

const roots: string[] = []
const packageRoot = fileURLToPath(new URL("..", import.meta.url))
beforeAll(buildMigrationRuntime)
afterEach(() => teardownRoots(roots))
function write(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value))
}
function json(path: string) { return JSON.parse(readFileSync(path, "utf8")) }
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "omo-validation-"))
  roots.push(root)
  const home = join(root, "home"), agent = join(root, "agent"), config = join(root, "config", "opencode")
  mkdirSync(home)
  return { root, home, agent, config }
}
function run(item: ReturnType<typeof fixture>, args = ["migrate", "--yes"], entry = join(packageRoot, "bin", "omo.js")) {
  return spawnSync(process.execPath, [entry, ...args], {
    encoding: "utf8", cwd: item.home,
    env: {
      PATH: process.env.PATH, HOME: item.home, USERPROFILE: item.home,
      OMO_CODING_AGENT_DIR: item.agent, SENPI_CODING_AGENT_DIR: item.agent, PI_CODING_AGENT_DIR: item.agent,
      XDG_CONFIG_HOME: dirname(item.config), XDG_DATA_HOME: join(item.root, "data"),
      XDG_STATE_HOME: join(item.root, "state"), XDG_CACHE_HOME: join(item.root, "cache"),
    },
  })
}

test.each(["baseURL", "apiKey", "name"])("#given an empty provider %s #when migrating #then no unloadable model configuration is written", (field) => {
  const item = fixture()
  write(join(item.config, "opencode.json"), {
    provider: {
      good: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "https://good.test/v1" }, models: { good: {} } },
      custom: {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "https://example.test/v1", ...(field !== "name" ? { [field]: "" } : {}) },
        models: { m: field === "name" ? { name: "" } : {} },
      },
    },
  })
  const result = run(item)
  expect(result.status, result.stderr).toBe(0)
  const config = ModelConfig.loadSync(join(item.agent, "models.json"))
  expect(config.getError()).toBeUndefined()
  expect(config.getProvider("custom")).toBeUndefined()
  expect(config.getProvider("good")).toBeDefined()
  expect(json(join(item.agent, "opencode-migration-report.json")).warnings.some((line: string) => line.includes("custom"))).toBe(true)
})

test("#given invalid existing models #when migrating #then preflight leaves every target untouched", () => {
  const item = fixture()
  write(join(item.config, "opencode.json"), { model: "openai/gpt-5" })
  write(join(item.agent, "models.json"), { providers: { custom: { apiKey: "" } } })
  const result = run(item)
  expect(result.status).toBe(1)
  expect(existsSync(join(item.agent, "settings.json"))).toBe(false)
  expect(existsSync(join(item.agent, "opencode-migration-state.json"))).toBe(false)
  expect(json(join(item.agent, "models.json"))).toEqual({ providers: { custom: { apiKey: "" } } })
})

test.each(["new", "existing", "no-options"])("#given an unsupported provider with omitted fields and state=%s #when migrating #then every field warning survives", (state) => {
  const item = fixture()
  write(join(item.config, "opencode.json"), {
    provider: { unknown: { npm: "unsupported-sdk", options: state === "no-options" ? undefined : { baseURL: "https://example.test", headers: { Authorization: "SECRET_SENTINEL" } }, models: { m: { reasoning: true, limit: { input: 42 } } } } },
  })
  if (state === "existing") write(join(item.agent, "models.json"), { providers: { unknown: { baseUrl: "https://kept.test" } } })
  const result = run(item)
  expect(result.status).toBe(0)
  const warnings: string[] = json(join(item.agent, "opencode-migration-report.json")).warnings
  for (const path of ["models.m.reasoning", "models.m.limit.input", ...(state === "no-options" ? [] : ["options.headers"])]) expect(warnings.some((line) => line.includes(path))).toBe(true)
  expect(JSON.stringify(warnings) + result.stdout + result.stderr).not.toContain("SECRET_SENTINEL")
})

test("#given empty MCP and no generated bundle #when credential-only setup runs #then credentials still import", () => {
  const item = fixture()
  const app = join(item.root, "app")
  cpSync(join(packageRoot, "bin"), join(app, "bin"), { recursive: true })
  rmSync(join(app, "bin", "lib", "migration-runtime.js"), { force: true })
  write(join(app, "package.json"), { type: "module" })
  write(join(item.config, "opencode.json"), { mcp: {} })
  write(join(item.root, "data", "opencode", "auth.json"), { openai: { type: "api", key: "DUMMY" } })
  const result = run(item, ["setup", "--yes"], join(app, "bin", "omo.js"))
  expect(result.status, result.stderr).toBe(0)
  expect(json(join(item.agent, "auth.json")).openai.key).toBe("DUMMY")
})

test("#given malformed Markdown beside a valid agent #when migrating #then other data migrates and source is backed up", () => {
  const item = fixture()
  write(join(item.config, "opencode.json"), { model: "openai/gpt-5" })
  const bad = join(item.config, "agents", "bad.md")
  write(bad, "---\ndescription: [SECRET_SENTINEL\n---\nIgnored prompt\n")
  write(join(item.config, "agents", "good.md"), "---\ndescription: Good\n---\nKept prompt\n")
  const result = run(item)
  expect(result.status, result.stderr).toBe(0)
  expect(json(join(item.agent, "settings.json")).defaultModel).toBe("gpt-5")
  expect(json(join(item.home, ".omo", "omo.jsonc")).agents.good.prompt).toBe("Kept prompt")
  const report = json(join(item.agent, "opencode-migration-report.json"))
  expect(report.warnings.some((line: string) => line.includes("agents.bad"))).toBe(true)
  expect(JSON.stringify(report) + result.stdout + result.stderr).not.toContain("SECRET_SENTINEL")
  expect(json(join(report.backupDirectory, "manifest.json")).files.some((entry: { path: string }) => entry.path === bad)).toBe(true)
  expect(readdirSync(item.agent).some((name) => name.startsWith("migration-backup-"))).toBe(true)
})

test("#given invalid migrate arguments #when either entrypoint runs #then diagnostics and exit status match", () => {
  const item = fixture()
  const args = ["migrate", "--bogus"]
  const node = run(item, args)
  const compiledEntry = run(item, args, join(packageRoot, "compile-entry.ts"))
  expect(compiledEntry.status).toBe(node.status)
  expect(compiledEntry.stderr).toBe(node.stderr)
  expect(existsSync(join(item.home, ".omo"))).toBe(false)
})

test.each(["inline", "markdown"])("#given an enabled native agent and restricted %s source #when migrating #then the entire conflicting import is skipped", (source) => {
  const item = fixture()
  const existing = { description: "Existing reviewer", disable: false }
  write(join(item.home, ".omo", "omo.json"), { agents: { reviewer: existing } })
  write(join(item.config, "opencode.json"), {
    agent: {
      helper: { prompt: "Compatible helper" },
      ...(source === "inline" ? { reviewer: { prompt: "Restricted incoming prompt", permission: { edit: "deny" } } } : {}),
    },
  })
  if (source === "markdown") write(join(item.config, "agents", "reviewer.md"), "---\npermission:\n  edit: deny\n---\nRestricted incoming prompt\n")
  const result = run(item)
  expect(result.status, result.stderr).toBe(0)
  expect(json(join(item.home, ".omo", "omo.json")).agents.reviewer).toEqual(existing)
  const loaded = loadOmoConfig({ cwd: item.home, env: { HOME: item.home, USERPROFILE: item.home }, harness: "senpi" })
  expect(loaded.config.agents?.reviewer?.disable).toBe(false)
  expect(loaded.config.agents?.reviewer?.prompt).toBeUndefined()
  expect(loaded.config.agents?.helper?.prompt).toBe("Compatible helper")
  expect(json(join(item.agent, "opencode-migration-report.json")).warnings.some((line: string) => line.includes("agents.reviewer"))).toBe(true)
})
