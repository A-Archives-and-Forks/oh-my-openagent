import { afterEach, beforeAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { teardownRoots } from "./teardown.test-support"
import { buildMigrationRuntime } from "../../../script/build-migration-runtime"

const SOURCE_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)))
const roots: string[] = []

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "omo-migrate-regression-"))
  roots.push(root)
  const home = join(root, "home")
  const engineDir = join(root, "separate-engine", "agent")
  const xdgConfig = join(root, "xdg-config")
  const app = join(root, "app")
  mkdirSync(home, { recursive: true })
  cpSync(join(SOURCE_ROOT, "bin"), join(app, "bin"), { recursive: true })
  symlinkSync(resolve(SOURCE_ROOT, "..", "..", "node_modules"), join(app, "node_modules"), "junction")
  write(join(app, "package.json"), JSON.stringify({ name: "omo-ai", version: "test", type: "module" }))
  return { root, home, engineDir, xdgConfig, launcher: join(app, "bin", "omo.js") }
}

function run(item: ReturnType<typeof fixture>, args: readonly string[]) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: item.home,
    USERPROFILE: item.home,
    OMO_CODING_AGENT_DIR: item.engineDir,
    XDG_CONFIG_HOME: item.xdgConfig,
  }
  delete env.SENPI_CODING_AGENT_DIR
  delete env.PI_CODING_AGENT_DIR
  const result = spawnSync(process.execPath, [item.launcher, "migrate", ...args], { encoding: "utf8", env })
  if (result.error !== undefined) throw result.error
  return result
}

afterEach(() => {
  teardownRoots(roots)
})

beforeAll(async () => {
  await buildMigrationRuntime()
})

describe("omo migrate regressions", () => {
  test("#given a source config #when migrate lacks --yes #then it produces no migration state", () => {
    // given
    const item = fixture()
    write(join(item.xdgConfig, "opencode", "opencode.json"), JSON.stringify({ model: "azure/gpt-5" }))

    // when
    const result = run(item, [])

    // then
    expect(result.status).toBe(0)
    expect(existsSync(join(item.engineDir, "settings.json"))).toBe(false)
    expect(existsSync(join(item.engineDir, "opencode-migration-state.json"))).toBe(false)
  })

  test("#given an overridden engine directory and selected user omo.json #when migration applies #then it updates that selected config recursively", () => {
    // given
    const item = fixture()
    const userConfig = join(item.home, ".omo", "omo.json")
    write(userConfig, JSON.stringify({
      agents: { reviewer: { description: "keep this", disable: true } },
      categories: { deep: { model: "openai/gpt-5" } },
    }))
    write(join(item.xdgConfig, "opencode", "oh-my-openagent.json"), JSON.stringify({
      agents: { reviewer: { prompt: "import this safely" } },
      categories: { deep: { reasoningEffort: "high" } },
    }))

    // when
    const result = run(item, ["--yes"])

    // then
    expect(result.status).toBe(0)
    const migrated = JSON.parse(readFileSync(userConfig, "utf8"))
    expect(migrated.agents.reviewer).toEqual({
      description: "keep this",
      disable: true,
      prompt: "import this safely",
    })
    expect(migrated.categories.deep).toEqual({ model: "openai/gpt-5", reasoning: "high" })
    expect(existsSync(join(item.engineDir, "omo.jsonc"))).toBe(false)
  })

  test("#given permissions bindings and expression-bearing provider inputs #when migration applies #then it preserves only safe target semantics", () => {
    // given
    const item = fixture()
    write(join(item.xdgConfig, "opencode", "opencode.json"), JSON.stringify({
      model: "azure/gpt-5",
      permission: "ask",
      provider: {
        custom: {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "{env:CUSTOM_BASE_URL}", apiKey: "!security find-generic-password" },
          models: { current: { id: "upstream-model", name: "Current" } },
        },
        unsafe: {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "{file:secret.txt}" },
        },
      },
    }))
    write(join(item.xdgConfig, "opencode", "tui.json"), JSON.stringify({
      keybinds: { session_new: "ctrl+n,ctrl+shift+n", model_list: "none", leader: "ctrl+x" },
    }))
    write(join(item.xdgConfig, "opencode", "agents", "restricted.md"), [
      "---",
      "description: Restricted reviewer",
      "permission:",
      "  edit: deny",
      "---",
      "Review only.",
    ].join("\n"))

    // when
    const result = run(item, ["--yes"])

    // then
    expect(result.status).toBe(0)
    const settings = JSON.parse(readFileSync(join(item.engineDir, "settings.json"), "utf8"))
    expect(settings.defaultProvider).toBe("azure-openai-responses")
    expect(settings.defaultModel).toBe("gpt-5")
    expect(settings.permission).toEqual({ "*": "ask" })
    const bindings = JSON.parse(readFileSync(join(item.engineDir, "keybindings.json"), "utf8"))
    expect(bindings["app.session.new"]).toEqual(["ctrl+n", "ctrl+shift+n"])
    expect(bindings["app.model.select"]).toEqual([])
    expect(bindings).not.toHaveProperty("leader")
    const models = JSON.parse(readFileSync(join(item.engineDir, "models.json"), "utf8"))
    expect(models.providers.custom.baseUrl).toBe("${CUSTOM_BASE_URL}")
    expect(models.providers.custom.apiKey).toBe("$!security find-generic-password")
    expect(models.providers.custom.models[0].upstreamModelId).toBe("upstream-model")
    expect(models.providers).not.toHaveProperty("unsafe")
    const omoConfig = JSON.parse(readFileSync(join(item.home, ".omo", "omo.jsonc"), "utf8"))
    expect(omoConfig.agents.restricted.disable).toBe(true)
    expect(result.stdout).toContain("leader")
    expect(result.stdout).toContain("unsafe")
  })

  test("#given an unsupported MCP expression #when migration applies #then it skips only that server for manual review", () => {
    // given
    const item = fixture()
    write(join(item.xdgConfig, "opencode", "opencode.json"), JSON.stringify({
      model: "openai/gpt-5",
      mcp: { secret: { type: "remote", url: "{file:secret.txt}" } },
    }))

    // when
    const result = run(item, ["--yes"])

    // then
    expect(result.status).toBe(0)
    expect(existsSync(join(item.engineDir, "settings.json"))).toBe(true)
    expect(existsSync(join(item.engineDir, "mcp.json"))).toBe(false)
    expect(result.stdout).toContain("secret")
  })

  test("#given existing inline markdown and legacy agents #when migration applies #then every non-conflicting agent is retained", () => {
    // given
    const item = fixture()
    write(join(item.home, ".omo", "omo.json"), JSON.stringify({ agents: { existing: { description: "keep" } } }))
    write(join(item.xdgConfig, "opencode", "opencode.json"), JSON.stringify({
      agent: { restricted: { prompt: "Do not edit.", permission: { edit: "deny" } } },
    }))
    write(join(item.xdgConfig, "opencode", "agents", "reviewer.md"), [
      "---",
      "description: Markdown reviewer",
      "---",
      "Review carefully.",
    ].join("\n"))
    write(join(item.xdgConfig, "opencode", "oh-my-openagent.json"), JSON.stringify({
      agents: { oracle: { description: "Legacy oracle" } },
      categories: { deep: { model: "openai/gpt-5" } },
    }))

    // when
    const result = run(item, ["--yes"])

    // then
    expect(result.status).toBe(0)
    const migrated = JSON.parse(readFileSync(join(item.home, ".omo", "omo.json"), "utf8"))
    expect(migrated.agents.existing.description).toBe("keep")
    expect(migrated.agents.reviewer.prompt).toBe("Review carefully.")
    expect(migrated.agents.restricted.disable).toBe(true)
    expect(migrated.agents.oracle.description).toBe("Legacy oracle")
    expect(migrated.categories.deep.model).toBe("openai/gpt-5")
  })
})
