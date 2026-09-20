import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { ModelConfig } from "../../../node_modules/@code-yeongyu/senpi/dist/core/model-config.js"

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const root = mkdtempSync(join(tmpdir(), "omo-alias-qa-"))
const results = []
const write = (path, value) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value))
}
try {
  assert.ok(process.env.REVIEW_COMPILED_BINARY)
  for (const launcher of ["node", "compiled"]) for (const existing of [false, true]) {
    const base = join(root, `${launcher}-${existing}`)
    const home = join(base, "home"), agent = join(base, "agent"), config = join(base, "config", "opencode")
    mkdirSync(home, { recursive: true })
    const destination = "azure-openai-responses"
    const kept = { api: "openai-completions", baseUrl: "https://kept.test/v1", models: [{ id: "deployment-a", name: "Existing" }] }
    if (existing) write(join(agent, "models.json"), { providers: { [destination]: kept } })
    write(join(config, "opencode.json"), {
      model: "azure/deployment-a",
      provider: { azure: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "https://custom-azure.test/v1" }, models: { "deployment-a": { name: "Deployment A" } } } },
    })
    const result = spawnSync(launcher === "compiled" ? process.env.REVIEW_COMPILED_BINARY : process.execPath,
      [...(launcher === "node" ? [join(repo, "packages/omo-native/bin/omo.js")] : []), "migrate", "--yes"], {
        cwd: home, encoding: "utf8",
        env: {
          PATH: process.env.PATH, HOME: home, USERPROFILE: home, OMO_RUNTIME: "node",
          OMO_CODING_AGENT_DIR: agent, SENPI_CODING_AGENT_DIR: agent, PI_CODING_AGENT_DIR: agent,
          XDG_CONFIG_HOME: dirname(config), XDG_DATA_HOME: join(base, "data"),
          XDG_STATE_HOME: join(base, "state"), XDG_CACHE_HOME: join(base, "cache"),
        },
      })
    assert.equal(result.status, 0, result.stderr)
    const settings = JSON.parse(readFileSync(join(agent, "settings.json"), "utf8"))
    const models = ModelConfig.loadSync(join(agent, "models.json"))
    const provider = models.getProvider(settings.defaultProvider)
    assert.equal(models.getError(), undefined)
    assert.equal(settings.defaultProvider, destination)
    assert.deepEqual(models.getProviderIds(), [destination])
    assert.ok(provider?.models?.some((model) => model.id === settings.defaultModel))
    assert.equal(provider.baseUrl, existing ? kept.baseUrl : "https://custom-azure.test/v1")
    if (existing) assert.deepEqual(provider, kept)
    const warnings = JSON.parse(readFileSync(join(agent, "opencode-migration-report.json"), "utf8")).warnings
    if (existing) assert.ok(warnings.some((line) => line.includes(destination)))
    results.push({ launcher, existing, settings, providerIds: models.getProviderIds(), provider, warnings })
  }
  const receipt = JSON.stringify({ status: "PASS", consumer: "Senpi ModelConfig", results }, null, 2)
  writeFileSync(new URL("./provider-alias-qa.json", import.meta.url), `${receipt}\n`)
  console.log(receipt)
} finally {
  rmSync(root, { recursive: true, force: true })
}
