import { afterEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, cpSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { teardownRoots } from "./teardown.test-support"

const SOURCE_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)))
const roots: string[] = []

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "omo-content-import-"))
  roots.push(root)
  const home = join(root, "home")
  const agentDir = join(root, "senpi-agent")
  const xdgData = join(root, "xdg-data")
  const xdgConfig = join(root, "xdg-config")
  const app = join(root, "app")
  mkdirSync(home, { recursive: true })
  cpSync(join(SOURCE_ROOT, "bin"), join(app, "bin"), { recursive: true })
  write(join(app, "package.json"), JSON.stringify({ name: "omo-ai", version: "test", type: "module" }))
  return { root, home, agentDir, xdgData, xdgConfig, launcher: join(app, "bin", "omo.js") }
}

function run(item: ReturnType<typeof fixture>, args: string[]) {
  const env: NodeJS.ProcessEnv = {
    ...process.env, HOME: item.home, USERPROFILE: item.home, SENPI_CODING_AGENT_DIR: item.agentDir,
    XDG_DATA_HOME: item.xdgData, XDG_CONFIG_HOME: item.xdgConfig,
  }
  delete env.OMO_CODING_AGENT_DIR
  delete env.PI_CODING_AGENT_DIR
  const result = spawnSync(process.execPath, [item.launcher, ...args], { encoding: "utf8", env })
  if (result.error) throw result.error
  return result
}

afterEach(() => {
  teardownRoots(roots)
})

describe("omo setup content inheritance", () => {
  test("#given opencode mcp config with local and remote servers #when accepted #then mcp.json is written in senpi shape", () => {
    const item = fixture()
    write(join(item.xdgConfig, "opencode", "opencode.json"), JSON.stringify({
      mcp: {
        localtools: { type: "local", command: ["npx", "-y", "some-mcp"], environment: { API_KEY: "x" }, enabled: true, timeout: 5000 },
        web: { type: "remote", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer y" }, enabled: false },
      },
    }))

    const result = run(item, ["setup", "--yes"])

    expect(result.status).toBe(0)
    expect(result.stdout).toContain("mcp-planned-add: localtools, web")
    const written = JSON.parse(readFileSync(join(item.agentDir, "mcp.json"), "utf8"))
    expect(written).toEqual({
      mcpServers: {
        localtools: { type: "stdio", command: "npx", args: ["-y", "some-mcp"], env: { API_KEY: "x" }, enabled: true, startupTimeoutMs: 5000 },
        web: { type: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer y" }, enabled: false },
      },
    })
  })

  test("#given jsonc config with comments and an existing mcp server #when accepted #then comments parse and the existing server survives", () => {
    const item = fixture()
    write(join(item.xdgConfig, "opencode", "opencode.jsonc"), [
      "// user note",
      "{",
      '  "mcp": {',
      '    "newone": { "type": "remote", "url": "https://new.example.com/mcp", }, // trailing comma',
      "  }",
      "}",
    ].join("\n"))
    write(join(item.agentDir, "mcp.json"), JSON.stringify({ mcpServers: { existing: { type: "http", url: "https://old.example.com" } } }))

    const result = run(item, ["setup", "--yes"])

    expect(result.status).toBe(0)
    expect(result.stdout).toContain("mcp-planned-add: newone")
    const written = JSON.parse(readFileSync(join(item.agentDir, "mcp.json"), "utf8"))
    expect(written.mcpServers.existing).toEqual({ type: "http", url: "https://old.example.com" })
    expect(written.mcpServers.newone).toEqual({ type: "http", url: "https://new.example.com/mcp" })
    const backupName = readdirMcpBackups(item.agentDir)
    expect(backupName.length).toBe(1)
  })

  test("#given opencode skills and AGENTS.md #when accepted #then they copy without overwriting existing targets", () => {
    const item = fixture()
    write(join(item.xdgConfig, "opencode", "skills", "use-railway", "SKILL.md"), "---\nname: use-railway\ndescription: rail\n---\nbody\n")
    write(join(item.xdgConfig, "opencode", "AGENTS.md"), "global rules\n")
    write(join(item.agentDir, "skills", "use-railway", "SKILL.md"), "preexisting\n")

    const result = run(item, ["setup", "--yes"])

    expect(result.status).toBe(0)
    expect(result.stdout).toContain("skills-skipped-existing: use-railway")
    expect(readFileSync(join(item.agentDir, "skills", "use-railway", "SKILL.md"), "utf8")).toBe("preexisting\n")
    expect(readFileSync(join(item.agentDir, "AGENTS.md"), "utf8")).toBe("global rules\n")
    expect(result.stdout).toContain("agents-md: copied")
  })

  test("#given content already imported #when setup runs again #then every content line is skipped-existing", () => {
    const item = fixture()
    write(join(item.xdgConfig, "opencode", "opencode.json"), JSON.stringify({
      mcp: { web: { type: "remote", url: "https://mcp.example.com/mcp" } },
    }))
    write(join(item.xdgConfig, "opencode", "skills", "s1", "SKILL.md"), "---\nname: s1\ndescription: d\n---\n")

    const first = run(item, ["setup", "--yes"])
    expect(first.status).toBe(0)
    const second = run(item, ["setup", "--yes"])

    expect(second.status).toBe(0)
    expect(second.stdout).toContain("mcp-skipped-existing: web")
    expect(second.stdout).toContain("mcp-planned-add: none")
    expect(second.stdout).toContain("skills-skipped-existing: s1")
    expect(second.stdout).toContain("skills-planned-add: none")
  })
})

function readdirMcpBackups(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.startsWith("mcp.json.bak-"))
}
