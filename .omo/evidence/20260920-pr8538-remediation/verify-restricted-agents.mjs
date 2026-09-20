import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { loadOmoConfig } from "../../../packages/omo-config-core/src/index.ts"

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const root = mkdtempSync(join(tmpdir(), "omo-restricted-qa-"))
const results = []
const write = (path, value) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value))
}
try {
  assert.ok(process.env.REVIEW_COMPILED_BINARY)
  for (const launcher of ["node", "compiled"]) for (const source of ["inline", "markdown"])
    for (const layer of ["root", "senpi", "profile", "profile-senpi"]) for (const state of ["enabled", "disabled", "new"]) {
    const base = join(root, `${launcher}-${source}-${layer}-${state}`)
    const home = join(base, "home"), agent = join(base, "agent"), config = join(base, "config", "opencode")
    mkdirSync(home, { recursive: true })
    if (state !== "new") {
      const agentLayer = { agents: { reviewer: { description: "Keep existing", disable: state === "disabled" } } }
      const scoped = layer === "senpi" || layer === "profile-senpi" ? { "[senpi]": agentLayer } : agentLayer
      write(join(home, ".omo", "omo.json"), layer.startsWith("profile") ? { profiles: { unrelated: {}, testing: scoped } } : scoped)
    }
    if (source === "inline") write(join(config, "opencode.json"), { agent: { reviewer: { prompt: "Restricted incoming prompt", permission: { edit: "deny" } } } })
    else write(join(config, "agents", "reviewer.md"), "---\npermission:\n  edit: deny\n---\nRestricted incoming prompt\n")
    const result = spawnSync(launcher === "compiled" ? process.env.REVIEW_COMPILED_BINARY : "node",
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
    const loaded = loadOmoConfig({ cwd: home, env: { HOME: home, USERPROFILE: home }, harness: "senpi", profile: layer.startsWith("profile") && state !== "new" ? "testing" : undefined })
    const reviewer = loaded.config.agents?.reviewer
    assert.equal(reviewer?.disable, state !== "enabled")
    assert.equal(reviewer?.prompt, state === "enabled" ? undefined : "Restricted incoming prompt")
    if (state !== "new") assert.equal(reviewer?.description, "Keep existing")
    const warnings = JSON.parse(readFileSync(join(agent, "opencode-migration-report.json"), "utf8")).warnings
    results.push({ launcher, source, layer, state, disable: reviewer?.disable, prompt: reviewer?.prompt ?? null, warnings })
  }
  const receipt = JSON.stringify({ status: "PASS", consumer: "loadOmoConfig(harness:senpi)", results }, null, 2)
  writeFileSync(new URL("./restricted-agent-qa.json", import.meta.url), `${receipt}\n`)
  console.log(receipt)
} finally {
  rmSync(root, { recursive: true, force: true })
}
