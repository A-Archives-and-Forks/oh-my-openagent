import { afterEach, beforeAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
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
  const root = mkdtempSync(join(tmpdir(), "omo-migrate-"))
  roots.push(root)
  const home = join(root, "home")
  const omoRoot = join(root, "omo-home")
  const agentDir = join(omoRoot, "agent")
  const xdgData = join(root, "xdg-data")
  const xdgConfig = join(root, "xdg-config")
  const app = join(root, "app")
  mkdirSync(home, { recursive: true })
  cpSync(join(SOURCE_ROOT, "bin"), join(app, "bin"), { recursive: true })
  write(join(app, "package.json"), JSON.stringify({ name: "omo-ai", version: "test", type: "module" }))
  return { root, home, agentDir, xdgData, xdgConfig, omoRoot, launcher: join(app, "bin", "omo.js") }
}

function run(item: ReturnType<typeof fixture>, args: string[]) {
  const env: NodeJS.ProcessEnv = {
    ...process.env, HOME: item.home, USERPROFILE: item.home, SENPI_CODING_AGENT_DIR: item.agentDir,
    XDG_DATA_HOME: item.xdgData, XDG_CONFIG_HOME: item.xdgConfig,
  }
  delete env.PI_CODING_AGENT_DIR
  const result = spawnSync(process.execPath, [item.launcher, ...args], { encoding: "utf8", env })
  if (result.error) throw result.error
  return result
}

afterEach(() => {
  teardownRoots(roots)
})

beforeAll(async () => {
  await buildMigrationRuntime()
})

describe("omo migrate", () => {
  test("#given opencode config with model and permission #when migrate runs #then settings.json gains the translated keys", () => {
    const item = fixture()
    write(join(item.xdgConfig, "opencode", "opencode.json"), JSON.stringify({
      model: "anthropic/claude-opus-4-5",
      permission: { bash: { "rm *": "ask", "git status": "allow" }, edit: "deny" },
    }))

    const result = run(item, ["migrate", "--yes"])

    expect(result.status).toBe(0)
    expect(result.stdout).toContain("settings: migrated")
    const settings = JSON.parse(readFileSync(join(item.agentDir, "settings.json"), "utf8"))
    expect(settings.defaultProvider).toBe("anthropic")
    expect(settings.defaultModel).toBe("claude-opus-4-5")
    expect(settings.permission).toEqual({ bash: { "rm *": "ask", "git status": "allow" }, edit: "deny" })
  })

  test("#given custom providers in opencode config #when migrate runs #then models.json gains them", () => {
    const item = fixture()
    write(join(item.xdgConfig, "opencode", "opencode.json"), JSON.stringify({
      provider: {
        local: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://localhost:11434/v1" }, models: { llama3: { name: "Llama 3" } } },
      },
    }))

    const result = run(item, ["migrate", "--yes"])

    expect(result.status).toBe(0)
    const models = JSON.parse(readFileSync(join(item.agentDir, "models.json"), "utf8"))
    expect(models.providers.local.baseUrl).toBe("http://localhost:11434/v1")
    expect(models.providers.local.api).toBe("openai-completions")
    expect(models.providers.local.models).toEqual([{ id: "llama3", name: "Llama 3" }])
  })

  test("#given tui keybinds and an agent markdown #when migrate runs #then keybindings map best-effort and the agent lands in omo.jsonc", () => {
    const item = fixture()
    write(join(item.xdgConfig, "opencode", "tui.json"), JSON.stringify({
      keybinds: { session_new: "ctrl+n", model_list: "ctrl+l", leader: "ctrl+x" },
    }))
    write(join(item.xdgConfig, "opencode", "agents", "reviewer.md"), [
      "---",
      "description: Code reviewer",
      "model: anthropic/claude-opus-4-5",
      "---",
      "Review the diff carefully.",
    ].join("\n"))

    const result = run(item, ["migrate", "--yes"])

    expect(result.status).toBe(0)
    const keybindings = JSON.parse(readFileSync(join(item.agentDir, "keybindings.json"), "utf8"))
    expect(keybindings["app.session.new"]).toBe("ctrl+n")
    expect(keybindings["app.model.select"]).toBe("ctrl+l")
    expect(result.stdout).toContain("keybindings.leader")
    const omoConfig = readFileSync(join(item.home, ".omo", "omo.jsonc"), "utf8")
    const parsed = JSON.parse(omoConfig)
    expect(parsed.agents.reviewer.description).toBe("Code reviewer")
    expect(parsed.agents.reviewer.prompt).toBe("Review the diff carefully.")
    expect(parsed.agents.reviewer.model).toBe("anthropic/claude-opus-4-5")
  })

  test("#given oh-my-openagent.json with shared-schema keys #when migrate runs #then omo.jsonc gains categories and the opencode-only keys are reported", () => {
    const item = fixture()
    write(join(item.xdgConfig, "opencode", "oh-my-openagent.json"), JSON.stringify({
      categories: { deep: { model: "anthropic/claude-opus-4-5" } },
      runtime_fallback: { enabled: true },
      tmux: { enabled: true, layout: "main-left" },
    }))

    const result = run(item, ["migrate", "--yes"])

    expect(result.status).toBe(0)
    const parsed = JSON.parse(readFileSync(join(item.home, ".omo", "omo.jsonc"), "utf8"))
    expect(parsed.categories.deep.model).toBe("anthropic/claude-opus-4-5")
    expect(result.stdout).toContain("manual-review")
    expect(result.stdout).toContain("tmux")
  })

  test("#given a full opencode state #when migrate runs twice and dry-run first #then dry-run writes nothing and the second real run is idempotent", () => {
    const item = fixture()
    write(join(item.xdgConfig, "opencode", "opencode.json"), JSON.stringify({
      model: "openai/gpt-5",
      mcp: { web: { type: "remote", url: "https://mcp.example.com/mcp" } },
    }))

    const dry = run(item, ["migrate", "--dry-run"])
    expect(dry.status).toBe(0)
    expect(dry.stdout).toContain("DRY RUN")
    expect(existsSync(join(item.agentDir, "settings.json"))).toBe(false)

    const first = run(item, ["migrate", "--yes"])
    expect(first.status).toBe(0)
    expect(first.stdout).toContain("settings: migrated")
    const backups = readdirSync(join(item.agentDir)).filter((name) => name.startsWith("migration-backup-"))
    expect(backups.length).toBe(1)

    const second = run(item, ["migrate", "--yes"])
    expect(second.status).toBe(0)
    expect(second.stdout).toContain("settings: already migrated")
    expect(readdirSync(join(item.agentDir)).filter((name) => name.startsWith("migration-backup-")).length).toBe(1)
  })
})
