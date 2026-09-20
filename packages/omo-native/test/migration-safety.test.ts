import { afterEach, beforeAll, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { buildMigrationRuntime } from "../../../script/build-migration-runtime"
import { teardownRoots } from "./teardown.test-support"
import { resolveConfigValue } from "../../../node_modules/@code-yeongyu/senpi/dist/core/resolve-config-value.js"

const roots: string[] = []
const launcher = fileURLToPath(new URL("../bin/omo.js", import.meta.url))
beforeAll(buildMigrationRuntime)
afterEach(() => teardownRoots(roots))

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "omo-migration-safety-"))
  roots.push(root)
  return { root, home: join(root, "home"), config: join(root, "config", "opencode"), agent: join(root, "agent") }
}
function write(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value))
}
function run(item: ReturnType<typeof fixture>) {
  mkdirSync(item.home, { recursive: true })
  return spawnSync(process.execPath, [launcher, "migrate", "--yes"], {
    encoding: "utf8", cwd: item.home,
    env: {
      PATH: process.env.PATH, HOME: item.home, USERPROFILE: item.home,
      OMO_CODING_AGENT_DIR: item.agent, SENPI_CODING_AGENT_DIR: item.agent, PI_CODING_AGENT_DIR: item.agent,
      XDG_CONFIG_HOME: dirname(item.config), XDG_DATA_HOME: join(item.root, "data"),
      XDG_STATE_HOME: join(item.root, "state"), XDG_CACHE_HOME: join(item.root, "cache"),
    },
  })
}
function json(path: string) {
  return JSON.parse(readFileSync(path, "utf8"))
}

test("#given a mapped leader chord #when migrating #then it is reported without writing an unusable binding", () => {
  const item = fixture()
  write(join(item.config, "tui.json"), { keybinds: { session_new: "<leader>n" } })
  const result = run(item)
  expect(result.status).toBe(0)
  expect(existsSync(join(item.agent, "keybindings.json"))).toBe(false)
  expect(json(join(item.agent, "opencode-migration-report.json")).warnings.some((entry: string) => entry.includes("keybindings.session_new"))).toBe(true)
})

test("#given old migration state and a masking jsonc #when rerun #then both user configuration layers survive", () => {
  const item = fixture()
  write(join(item.home, ".omo", "omo.json"), { categories: { quick: { model: "openai/gpt-5-mini" } } })
  write(join(item.home, ".omo", "omo.jsonc"), { agents: { reviewer: { prompt: "Keep me" } } })
  write(join(item.agent, "opencode-migration-state.json"), { items: { "omo-config": true } })
  write(join(item.config, "oh-my-openagent.json"), { agents: { oracle: { model: "openai/gpt-5" } } })
  const result = run(item)
  expect(result.status).toBe(0)
  const config = json(join(item.home, ".omo", "omo.jsonc"))
  expect(config.categories?.quick?.model).toBe("openai/gpt-5-mini")
  expect(config.agents.reviewer.prompt).toBe("Keep me")
  expect(config.agents.oracle.model).toBe("openai/gpt-5")
})

test("#given a literal command-shaped API key #when migrating #then it never becomes an executable credential command", async () => {
  const item = fixture()
  write(join(item.config, "opencode.json"), {
    provider: { custom: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "https://example.test/v1", apiKey: "!printf DUMMY_SECRET" }, models: { m: {} } } },
  })
  const result = run(item)
  expect(result.status).toBe(0)
  expect(json(join(item.agent, "models.json")).providers.custom.apiKey).toBe("$!printf DUMMY_SECRET")
  expect(await resolveConfigValue(json(join(item.agent, "models.json")).providers.custom.apiKey)).toBe("!printf DUMMY_SECRET")
  expect(result.stdout).not.toContain("DUMMY_SECRET")
})

test("#given conflicting prompt text #when merging #then diagnostics never serialize the prompt values", () => {
  const item = fixture()
  write(join(item.home, ".omo", "omo.json"), { agents: { oracle: { prompt: "EXISTING_SECRET_SENTINEL" } } })
  write(join(item.config, "oh-my-openagent.json"), { agents: { oracle: { prompt: "SOURCE_SECRET_SENTINEL" } } })
  const result = run(item)
  expect(result.status).toBe(0)
  const report = readFileSync(join(item.agent, "opencode-migration-report.json"), "utf8")
  for (const secret of ["EXISTING_SECRET_SENTINEL", "SOURCE_SECRET_SENTINEL"]) {
    expect(result.stdout + result.stderr + report).not.toContain(secret)
  }
  expect(json(join(item.home, ".omo", "omo.json")).agents.oracle.prompt).toBe("EXISTING_SECRET_SENTINEL")
})

test("#given a malformed MCP server container #when migrating #then all existing bytes remain unchanged", () => {
  const item = fixture()
  const target = join(item.agent, "mcp.json")
  write(target, { mcpServers: [] })
  write(join(item.config, "opencode.json"), { model: "openai/gpt-5", mcp: { web: { type: "remote", url: "https://example.test/mcp" } } })
  const before = readFileSync(target, "utf8")
  const result = run(item)
  expect(result.status).toBe(1)
  expect(readFileSync(target, "utf8")).toBe(before)
  expect(existsSync(join(item.agent, "settings.json"))).toBe(false)
})

test("#given invalid permission actions #when migrating #then it fails before writing settings", () => {
  const item = fixture()
  write(join(item.config, "opencode.json"), { model: "openai/gpt-5", permission: "unexpected" })
  const result = run(item)
  expect(result.status).toBe(1)
  expect(existsSync(join(item.agent, "settings.json"))).toBe(false)
})

test("#given malformed secret-bearing JSON #when migration rejects it #then the error contains no source bytes", () => {
  const item = fixture()
  mkdirSync(item.config, { recursive: true })
  writeFileSync(join(item.config, "opencode.json"), "CONFIDENTIAL_SECRET invalid JSON")
  const result = run(item)
  expect(result.status).toBe(1)
  expect(result.stdout + result.stderr).not.toContain("CONFIDENTIAL_SECRET")
  expect(existsSync(join(item.agent, "settings.json"))).toBe(false)
})

test("#given a Markdown agent source #when migration succeeds #then the source is included in a reversible backup manifest", () => {
  const item = fixture()
  const source = join(item.config, "agents", "reviewer.md")
  mkdirSync(dirname(source), { recursive: true })
  writeFileSync(source, "---\ndescription: Reviewer\n---\nReview carefully.\n")
  const result = run(item)
  expect(result.status).toBe(0)
  const backupName = readdirSync(item.agent).find((name) => name.startsWith("migration-backup-"))
  expect(backupName).toBeDefined()
  if (backupName === undefined) throw new Error("backup missing")
  const backup = join(item.agent, backupName)
  const manifest = json(join(backup, "manifest.json"))
  const entry = manifest.files.find((file: { path: string }) => file.path === source)
  expect(entry).toBeDefined()
  expect(readFileSync(join(backup, entry.backup), "utf8")).toBe(readFileSync(source, "utf8"))
})

test("#given an unknown provider API #when migrating #then it reports rather than writing an unloadable provider", () => {
  const item = fixture()
  write(join(item.config, "opencode.json"), {
    provider: { custom: { npm: "unsupported-sdk", options: { baseURL: "https://example.test/v1" }, models: { m: {} } } },
  })
  const result = run(item)
  expect(result.status).toBe(0)
  expect(existsSync(join(item.agent, "models.json"))).toBe(false)
  expect(json(join(item.agent, "opencode-migration-report.json")).warnings.some((entry: string) => entry.includes("models.custom"))).toBe(true)
})

test("#given an old migration copied unsupported codegraph #when repairing #then supported settings still migrate", () => {
  const item = fixture()
  write(join(item.agent, "opencode-migration-state.json"), { items: { "omo-config": true } })
  write(join(item.home, ".omo", "omo.jsonc"), { codegraph: { enabled: true }, agents: { existing: { prompt: "Keep" } } })
  write(join(item.config, "oh-my-openagent.json"), { agents: { oracle: { model: "openai/gpt-5" } } })
  const result = run(item)
  expect(result.status).toBe(0)
  const migrated = json(join(item.home, ".omo", "omo.jsonc"))
  expect(migrated.codegraph).toBeUndefined()
  expect(migrated.agents.existing.prompt).toBe("Keep")
  expect(migrated.agents.oracle.model).toBe("openai/gpt-5")
})

test("#given an applied migration #when unsupported config is added #then the durable report is refreshed", () => {
  const item = fixture()
  const source = join(item.config, "oh-my-openagent.json")
  write(source, {})
  expect(run(item).status).toBe(0)
  write(source, { codegraph: { enabled: true } })

  expect(run(item).status).toBe(0)

  expect(json(join(item.agent, "opencode-migration-report.json")).warnings.some((entry: string) => entry.includes("codegraph"))).toBe(true)
})

test("#given unresolved warnings and migrated agents #when unchanged input is rerun #then report bytes and backups remain stable", () => {
  const item = fixture()
  write(join(item.config, "opencode.json"), { autoupdate: false })
  write(join(item.config, "oh-my-openagent.json"), { codegraph: {}, agents: { reviewer: { prompt: "Review" } } })
  expect(run(item).status).toBe(0)
  const path = join(item.agent, "opencode-migration-report.json")
  const before = readFileSync(path, "utf8")
  const backups = readdirSync(item.agent).filter((name) => name.startsWith("migration-backup-"))

  expect(run(item).status).toBe(0)

  expect(readFileSync(path, "utf8")).toBe(before)
  expect(readdirSync(item.agent).filter((name) => name.startsWith("migration-backup-"))).toEqual(backups)
})

test("#given a reported unsupported setting #when the source removes it #then the durable warning is removed", () => {
  const item = fixture()
  const source = join(item.config, "oh-my-openagent.json")
  write(source, { codegraph: {} })
  expect(run(item).status).toBe(0)
  write(source, {})

  expect(run(item).status).toBe(0)

  expect(json(join(item.agent, "opencode-migration-report.json")).warnings).toEqual([])
})
