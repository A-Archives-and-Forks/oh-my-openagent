import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { loadMcpConfig } from "../../../node_modules/@code-yeongyu/senpi/dist/core/extensions/builtin/mcp/config.js"
import { SettingsManager } from "../../../node_modules/@code-yeongyu/senpi/dist/core/settings-manager.js"
import { AuthStorage } from "../../../node_modules/@code-yeongyu/senpi/dist/core/auth-storage.js"
import { KeybindingsManager } from "../../../node_modules/@code-yeongyu/senpi/dist/core/keybindings.js"
import { loadPermissionSettings } from "../../../node_modules/@code-yeongyu/senpi/dist/core/extensions/builtin/permission-system/settings.js"
import { evaluate } from "../../../node_modules/@code-yeongyu/senpi/dist/core/extensions/builtin/permission-system/evaluate.js"
import { validateOmoConfig } from "../../../packages/omo-native/bin/lib/migration-runtime.js"

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const root = mkdtempSync(join(tmpdir(), "omo-pr8538-final-"))
const receipts = []
const write = (path, value) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value))
}
const json = (path) => JSON.parse(readFileSync(path, "utf8"))

function fixture(name) {
  const base = join(root, name)
  const home = join(base, "home")
  const agent = join(base, "custom", "agent")
  const config = join(base, "config", "opencode")
  mkdirSync(home, { recursive: true })
  return { base, home, agent, config }
}

function run(item, args, expectedExit = 0) {
  const binary = process.env.REVIEW_COMPILED_BINARY
  const result = spawnSync(binary ?? process.execPath, binary ? args : [join(repo, "packages/omo-native/bin/omo.js"), ...args], {
    cwd: item.home,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: item.home,
      USERPROFILE: item.home,
      OMO_RUNTIME: "node",
      OMO_CODING_AGENT_DIR: item.agent,
      SENPI_CODING_AGENT_DIR: item.agent,
      PI_CODING_AGENT_DIR: item.agent,
      XDG_CONFIG_HOME: dirname(item.config),
      XDG_DATA_HOME: join(item.base, "data"),
      XDG_CACHE_HOME: join(item.base, "cache"),
      XDG_STATE_HOME: join(item.base, "state"),
    },
  })
  if (result.error) throw result.error
  receipts.push({ scenario: item.base.split("/").pop(), args, status: result.status, stdout: result.stdout, stderr: result.stderr })
  assert.equal(result.status, expectedExit, result.stderr)
}

try {
  const setup = fixture("setup")
  write(join(setup.base, "data", "opencode", "auth.json"), {
    "anthropic-api": { type: "api", key: "DUMMY_SETUP_KEY" },
    openai: { type: "api", key: "!printf OMO_LITERAL_KEY" },
    google: { type: "api", key: "${OMO_UNSET_LITERAL}" },
    opencode: { type: "oauth", access: "DUMMY" },
  })
  write(join(setup.config, "opencode.json"), {
    mcp: { remote: { type: "remote", url: "https://example.test/mcp", headers: { Authorization: "Bearer {env:REVIEW_MCP_TOKEN}" } } },
  })
  run(setup, ["setup", "--yes"])
  const credentials = AuthStorage.create(join(setup.agent, "auth.json"))
  assert.equal(await credentials.getApiKey("anthropic", { includeFallback: false }), "DUMMY_SETUP_KEY")
  assert.equal(await credentials.getApiKey("openai", { includeFallback: false }), "!printf OMO_LITERAL_KEY")
  assert.equal(await credentials.getApiKey("google", { includeFallback: false }), "${OMO_UNSET_LITERAL}")
  const setupMcp = loadMcpConfig({ cwd: setup.home, agentDir: setup.agent, projectTrusted: false, env: { REVIEW_MCP_TOKEN: "DUMMY" } })
  assert.equal(setupMcp.servers.remote.config.headers.Authorization, "Bearer DUMMY")

  const help = fixture("help")
  write(join(help.config, "opencode.json"), { model: "anthropic/claude-opus-4-5" })
  run(help, ["migrate", "--help"])
  assert.equal(existsSync(help.agent), false)
  assert.equal(existsSync(join(help.home, ".omo")), false)

  const full = fixture("full")
  const omoPath = join(full.home, ".omo", "omo.json")
  write(omoPath, { categories: { quick: { model: "openai/gpt-5-mini" } }, agents: { existing: { model: "openai/gpt-5" } } })
  write(join(full.agent, "settings.json"), { defaultProvider: "openai" })
  write(join(full.config, "opencode.json"), {
    model: "anthropic/claude-opus-4-5",
    permission: "ask",
    provider: {
      custom: {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "https://example.test/v1", apiKey: "{env:REVIEW_API_KEY}" },
        models: { alias: { id: "wire-model", name: "Wire", limit: { context: 8000, output: 1000 } } },
      },
    },
    agent: { restricted: { description: "Must remain restricted", permission: { edit: "deny" } } },
    mcp: { remote: { type: "remote", url: "https://example.test/mcp", headers: { Authorization: "Bearer {env:REVIEW_MCP_TOKEN}" } } },
  })
  write(join(full.config, "tui.json"), { keybinds: { model_list: "ctrl+l,ctrl+m", session_new: "<leader>n", app_exit: "none" } })
  write(join(full.config, "agents", "reviewer.md"), "---\ndescription: Review code\nmodel: anthropic/claude-opus-4-5\n---\nReview carefully.\n")
  write(join(full.config, "oh-my-openagent.json"), {
    categories: { deep: { model: "anthropic/claude-opus-4-5" } },
    agents: { oracle: { model: "openai/gpt-5" } },
    codegraph: { enabled: true },
  })
  const before = readFileSync(omoPath, "utf8")
  run(full, ["migrate", "--dry-run"])
  assert.equal(readFileSync(omoPath, "utf8"), before)
  assert.equal(existsSync(join(full.agent, "opencode-migration-state.json")), false)
  run(full, ["migrate", "--yes"])
  assert.equal(existsSync(join(full.home, ".omo", "omo.jsonc")), false)
  assert.equal(existsSync(join(dirname(full.agent), "omo.jsonc")), false)
  const omo = json(omoPath)
  assert.equal(omo.categories.quick.model, "openai/gpt-5-mini")
  assert.equal(omo.categories.deep.model, "anthropic/claude-opus-4-5")
  assert.equal(omo.agents.existing.model, "openai/gpt-5")
  assert.equal(omo.agents.oracle.model, "openai/gpt-5")
  assert.equal(omo.agents.reviewer.prompt, "Review carefully.")
  assert.ok(omo.agents.restricted === undefined || omo.agents.restricted.disable === true)
  assert.equal(omo.codegraph, undefined)
  assert.ok(validateOmoConfig(omo).value)
  const settings = json(join(full.agent, "settings.json"))
  assert.deepEqual(settings.permission, { "*": "ask" })
  assert.equal(settings.defaultProvider, "openai")
  assert.equal(settings.defaultModel, undefined)
  const permissions = loadPermissionSettings(SettingsManager.create(full.home, full.agent), [], full.home)
  assert.equal(evaluate("bash", "echo review", permissions.staticRuleset).action, "ask")
  assert.equal(evaluate("edit", join(full.home, "file"), permissions.staticRuleset).action, "ask")
  const models = json(join(full.agent, "models.json"))
  assert.equal(models.providers.custom.apiKey, "${REVIEW_API_KEY}")
  assert.equal(models.providers.custom.models[0].upstreamModelId, "wire-model")
  const keys = json(join(full.agent, "keybindings.json"))
  assert.deepEqual(keys["app.model.select"], ["ctrl+l", "ctrl+m"])
  assert.deepEqual(keys["app.exit"], [])
  assert.equal(keys["app.session.new"], undefined)
  assert.equal(KeybindingsManager.create(full.agent).matches("\x0c", "app.model.select"), true)
  const loaded = loadMcpConfig({ cwd: full.home, agentDir: full.agent, projectTrusted: false, env: { REVIEW_MCP_TOKEN: "DUMMY" } })
  assert.deepEqual(loaded.diagnostics, [])
  assert.equal(loaded.servers.remote.config.headers.Authorization, "Bearer DUMMY")
  const after = readFileSync(omoPath, "utf8")
  const reportBeforeRepeat = readFileSync(join(full.agent, "opencode-migration-report.json"), "utf8")
  run(full, ["migrate", "--yes"])
  assert.equal(readFileSync(omoPath, "utf8"), after)
  assert.equal(readFileSync(join(full.agent, "opencode-migration-report.json"), "utf8"), reportBeforeRepeat)

  const refresh = fixture("report-refresh")
  const refreshSource = join(refresh.config, "oh-my-openagent.json")
  write(refreshSource, {})
  run(refresh, ["migrate", "--yes"])
  write(refreshSource, { codegraph: {} })
  run(refresh, ["migrate", "--yes"])
  const refreshedPath = join(refresh.agent, "opencode-migration-report.json")
  assert.ok(json(refreshedPath).warnings.some((warning) => warning.includes("codegraph")))
  const refreshedBytes = readFileSync(refreshedPath, "utf8")
  const refreshedBackups = readdirSync(refresh.agent).filter((name) => name.startsWith("migration-backup-"))
  run(refresh, ["migrate", "--yes"])
  assert.equal(readFileSync(refreshedPath, "utf8"), refreshedBytes)
  assert.deepEqual(readdirSync(refresh.agent).filter((name) => name.startsWith("migration-backup-")), refreshedBackups)

  const invalid = fixture("malformed-mcp")
  write(join(invalid.config, "opencode.json"), { model: "anthropic/claude-opus-4-5", mcp: { remote: { type: "remote", url: "https://example.test/mcp" } } })
  write(join(invalid.agent, "mcp.json"), "{")
  run(invalid, ["migrate", "--yes"], 1)
  assert.equal(existsSync(join(invalid.agent, "settings.json")), false)
  assert.equal(existsSync(join(invalid.agent, "opencode-migration-state.json")), false)
  assert.equal(readFileSync(join(invalid.agent, "mcp.json"), "utf8"), "{")

  const legacy = fixture("old-marker-repair")
  write(join(legacy.home, ".omo", "omo.json"), { categories: { quick: { model: "openai/gpt-5-mini" } } })
  write(join(legacy.home, ".omo", "omo.jsonc"), { agents: { reviewer: { prompt: "Already migrated" } } })
  write(join(legacy.agent, "opencode-migration-state.json"), { items: { settings: true, agents: true, "omo-config": true } })
  write(join(legacy.config, "oh-my-openagent.json"), { agents: { oracle: { model: "openai/gpt-5" } } })
  run(legacy, ["migrate", "--yes"])
  const repaired = json(join(legacy.home, ".omo", "omo.jsonc"))
  assert.equal(repaired.categories.quick.model, "openai/gpt-5-mini")
  assert.equal(repaired.agents.reviewer.prompt, "Already migrated")
  assert.equal(repaired.agents.oracle.model, "openai/gpt-5")

  for (const command of ["setup", "migrate"]) {
    const layers = fixture(`source-layers-${command}`)
    write(join(layers.config, "config.json"), { mcp: { legacy: { type: "remote", url: "https://legacy.test/mcp" } } })
    write(join(layers.config, "opencode.json"), {
      model: "openai/gpt-5", permission: "allow", default_agent: "reviewer", instructions: ["RULES.md"],
      agent: { "team/reviewer": { model: "openai/gpt-5", permission: { edit: "deny" } } },
      provider: { custom: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "https://example.test/v1", headers: { Authorization: "DUMMY" } }, models: { m: {} } } },
      mcp: { json: { type: "remote", url: "https://json.test/mcp" } },
    })
    write(join(layers.config, "opencode.jsonc"), {
      model: "anthropic/claude-opus-4-5", permission: "deny",
      mcp: {
        jsonc: { type: "remote", url: "https://jsonc.test/mcp" },
        literal: { type: "remote", url: "https://literal.test/mcp", headers: { Authorization: "Bearer ${OPENAI_API_KEY}" } },
      },
    })
    write(join(layers.config, "tui.json"), { keybinds: { session_new: "ctrl+n", model_list: "ctrl+l" } })
    write(join(layers.config, "tui.jsonc"), { keybinds: { model_list: "ctrl+m" } })
    const nestedSource = join(layers.config, "agents", "team", "reviewer.md")
    write(nestedSource, "---\ndescription: Nested reviewer\n---\nReview nested code.\n")
    run(layers, [command, "--yes"])
    const mcp = loadMcpConfig({ cwd: layers.home, agentDir: layers.agent, projectTrusted: false, env: { OPENAI_API_KEY: "EXPANDED" } })
    assert.deepEqual(Object.keys(mcp.servers).sort(), ["json", "jsonc", "legacy"])
    if (command === "migrate") {
      assert.equal(json(join(layers.agent, "settings.json")).defaultProvider, "anthropic")
      assert.deepEqual(json(join(layers.agent, "settings.json")).permission, { "*": "deny" })
      const agent = json(join(layers.home, ".omo", "omo.jsonc")).agents["team/reviewer"]
      assert.equal(agent.prompt, "Review nested code.")
      assert.equal(agent.model, "openai/gpt-5")
      assert.equal(agent.disable, true)
      assert.equal(json(join(layers.agent, "keybindings.json"))["app.model.select"], "ctrl+m")
      const receipt = json(join(layers.agent, "opencode-migration-report.json"))
      for (const key of ["default_agent", "instructions", "options.headers"]) assert.ok(receipt.warnings.some((entry) => entry.includes(key)))
      const backedUp = json(join(receipt.backupDirectory, "manifest.json")).files.map((entry) => entry.path)
      for (const name of ["config.json", "opencode.json", "opencode.jsonc", "tui.json", "tui.jsonc"]) assert.ok(backedUp.includes(join(layers.config, name)))
      assert.ok(backedUp.includes(nestedSource))
    }
    const invalidSchema = fixture(`schema-invalid-${command}`)
    write(join(invalidSchema.base, "data", "opencode", "auth.json"), { openai: { type: "api", key: "DUMMY" } })
    write(join(invalidSchema.config, "opencode.json"), { model: "openai/gpt-5", mcp: { new: { type: "remote", url: "https://new.test/mcp" } } })
    write(join(invalidSchema.agent, "mcp.json"), { mcpServers: { broken: { type: "http" } } })
    run(invalidSchema, [command, "--yes"], 1)
    assert.equal(existsSync(join(invalidSchema.agent, "auth.json")), false)
    assert.equal(existsSync(join(invalidSchema.agent, "settings.json")), false)
    assert.deepEqual(json(join(invalidSchema.agent, "mcp.json")), { mcpServers: { broken: { type: "http" } } })
  }

  const report = JSON.stringify({ status: "PASS", scenarios: receipts, consumers: ["OmoConfigLayerSchema", "Senpi loadMcpConfig", "Senpi AuthStorage", "Senpi permission settings and evaluator", "Senpi KeybindingsManager"], isolation: "temporary HOME, custom agent directory and XDG roots", cleanup: "temporary fixtures removed in finally" }, null, 2)
  writeFileSync(new URL(process.env.REVIEW_COMPILED_BINARY ? "./compiled-consumer-qa.json" : "./consumer-qa.json", import.meta.url), `${report}\n`)
  console.log(report)
} finally {
  rmSync(root, { recursive: true, force: true })
}
