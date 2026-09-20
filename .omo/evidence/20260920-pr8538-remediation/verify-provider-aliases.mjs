import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { ModelConfig } from "../../../node_modules/@code-yeongyu/senpi/dist/core/model-config.js"
import { ModelRegistry } from "../../../node_modules/@code-yeongyu/senpi/dist/core/model-registry.js"
import { AuthStorage } from "../../../node_modules/@code-yeongyu/senpi/dist/core/auth-storage.js"

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const root = mkdtempSync(join(tmpdir(), "omo-alias-qa-"))
const results = []
const write = (path, value) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value))
}
function snapshot(path) {
  return Object.fromEntries(readdirSync(path, { withFileTypes: true }).map((entry) => {
    const child = join(path, entry.name)
    if (entry.isDirectory()) return [entry.name, snapshot(child)]
    assert.ok(entry.isFile())
    return [entry.name, readFileSync(child, "base64")]
  }))
}
try {
  assert.ok(process.env.REVIEW_COMPILED_BINARY)
  for (const launcher of ["node", "compiled"]) for (const state of ["new", "new-missing", "matching", "missing", "disabled", "globally-disabled"]) {
    const existing = state !== "new" && state !== "new-missing" && state !== "globally-disabled"
    const resolvable = state === "new" || state === "matching"
    const base = join(root, `${launcher}-${state}`)
    const home = join(base, "home"), agent = join(base, "agent"), config = join(base, "config", "opencode")
    mkdirSync(home, { recursive: true })
    const scratch = join(base, "scratch")
    mkdirSync(scratch)
    const destination = "azure-openai-responses"
    const kept = { api: "openai-completions", baseUrl: "https://kept.test/v1", models: [{ id: state === "missing" ? "different-deployment" : "deployment-a", name: "Existing" }], ...(state === "disabled" ? { disabled: true } : {}) }
    if (existing) write(join(agent, "models.json"), { providers: { [destination]: kept } })
    if (state === "globally-disabled") write(join(agent, "models.json"), { providers: {}, disabledProviders: [destination] })
    write(join(agent, "settings.json"), { theme: "dark" })
    write(join(config, "opencode.json"), {
      model: "azure/deployment-a",
      provider: { azure: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "https://custom-azure.test/v1" }, models: { [state === "new-missing" ? "different-deployment" : "deployment-a"]: { name: "Deployment A" } } } },
    })
    const invoke = (mode) => spawnSync(launcher === "compiled" ? process.env.REVIEW_COMPILED_BINARY : process.execPath,
      [...(launcher === "node" ? [join(repo, "packages/omo-native/bin/omo.js")] : []), "migrate", mode], {
        cwd: home, encoding: "utf8",
        env: {
          PATH: process.env.PATH, HOME: home, USERPROFILE: home, OMO_RUNTIME: "node",
          OMO_CODING_AGENT_DIR: agent, SENPI_CODING_AGENT_DIR: agent, PI_CODING_AGENT_DIR: agent,
          XDG_CONFIG_HOME: dirname(config), XDG_DATA_HOME: join(base, "data"),
          XDG_STATE_HOME: join(base, "state"), XDG_CACHE_HOME: join(base, "cache"),
          TMPDIR: scratch, TMP: scratch, TEMP: scratch,
        },
      })
    const before = snapshot(base)
    const preview = invoke("--dry-run")
    assert.equal(preview.status, 0, preview.stderr)
    assert.deepEqual(snapshot(base), before)
    const result = invoke("--yes")
    assert.equal(result.status, 0, result.stderr)
    const settings = JSON.parse(readFileSync(join(agent, "settings.json"), "utf8"))
    const models = ModelConfig.loadSync(join(agent, "models.json"))
    const provider = models.getProvider(destination)
    const registry = ModelRegistry.create(AuthStorage.inMemory(), join(agent, "models.json"))
    assert.equal(models.getError(), undefined)
    if (resolvable) {
      assert.equal(settings.defaultProvider, destination)
      assert.ok(registry.find(settings.defaultProvider, settings.defaultModel))
    } else {
      assert.deepEqual(settings, { theme: "dark" })
      assert.equal(registry.find(destination, "deployment-a"), undefined)
    }
    assert.deepEqual(models.getProviderIds(), [destination])
    assert.equal(provider.baseUrl, existing ? kept.baseUrl : "https://custom-azure.test/v1")
    if (existing) assert.deepEqual(provider, kept)
    const warnings = JSON.parse(readFileSync(join(agent, "opencode-migration-report.json"), "utf8")).warnings
    if (existing) assert.ok(warnings.some((line) => line.includes(destination)))
    results.push({ launcher, state, previewReadOnly: true, settings, defaultResolves: resolvable, providerIds: models.getProviderIds(), provider, warnings })
  }
  const receipt = JSON.stringify({ status: "PASS", consumer: "Senpi ModelRegistry.find and ModelConfig", results }, null, 2)
  writeFileSync(new URL("./provider-alias-qa.json", import.meta.url), `${receipt}\n`)
  console.log(receipt)
} finally {
  rmSync(root, { recursive: true, force: true })
}
