import { afterEach, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { PassThrough } from "node:stream"
import { fileURLToPath } from "node:url"
import { AuthStorage } from "../../../node_modules/@code-yeongyu/senpi/dist/core/auth-storage.js"
import { runSetup } from "../bin/lib/setup-import.js"
import { teardownRoots } from "./teardown.test-support"

const roots: string[] = []
afterEach(() => teardownRoots(roots))
const launcher = fileURLToPath(new URL("../bin/omo.js", import.meta.url))

function write(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value))
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "omo-setup-review-"))
  roots.push(root)
  const home = join(root, "home")
  const agent = join(root, "agent")
  const config = join(root, "config", "opencode")
  const data = join(root, "data", "opencode")
  mkdirSync(home)
  const env = {
    PATH: process.env.PATH, HOME: home, USERPROFILE: home,
    OMO_CODING_AGENT_DIR: agent, SENPI_CODING_AGENT_DIR: agent, PI_CODING_AGENT_DIR: agent,
    XDG_CONFIG_HOME: dirname(config), XDG_DATA_HOME: dirname(data),
    XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"),
  }
  return { root, home, agent, config, data, env }
}

test.each(["!printf OMO_LITERAL_KEY", "$OMO_UNSET_LITERAL", "${OMO_UNSET_LITERAL}", "prefix$HOME"])(
  "#given literal credential %s #when imported #then AuthStorage returns exactly the original bytes",
  async (key) => {
    const item = fixture()
    write(join(item.data, "auth.json"), { openai: { type: "api", key } })

    const result = spawnSync(process.execPath, [launcher, "setup", "--yes"], { cwd: item.home, env: item.env, encoding: "utf8" })

    expect(result.status).toBe(0)
    const store = AuthStorage.create(join(item.agent, "auth.json"))
    expect(await store.getApiKey("openai", { includeFallback: false })).toBe(key)
  },
)

test.each(["auth.json", "mcp.json", "AGENTS.md"])(
  "#given %s changes during consent #when the user accepts #then setup aborts without clobbering it",
  async (name) => {
    const item = fixture()
    write(join(item.data, "auth.json"), { openai: { type: "api", key: "DUMMY" } })
    write(join(item.config, "opencode.json"), { mcp: { web: { type: "remote", url: "https://example.test/mcp" } } })
    write(join(item.config, "AGENTS.md"), "Source rules")
    const input = Object.assign(new PassThrough(), { isTTY: true })
    const output = Object.assign(new PassThrough(), { isTTY: true })
    const changed = name === "AGENTS.md" ? "User changed rules" : JSON.stringify(name === "auth.json"
      ? { google: { type: "api_key", key: "CONCURRENT" } }
      : { mcpServers: { web: { type: "http", url: "https://concurrent.test" } } })
    let prompted = false
    output.on("data", (chunk) => {
      if (prompted || !String(chunk).includes("[y/N]")) return
      prompted = true
      queueMicrotask(() => {
        write(join(item.agent, name), changed)
        input.write("y\n")
      })
    })
    try {
      await expect(runSetup([], { home: item.home, env: item.env, stdin: input, stdout: output })).rejects.toThrow()
      expect(prompted).toBe(true)
      expect(readFileSync(join(item.agent, name), "utf8")).toBe(changed)
      for (const other of ["auth.json", "mcp.json", "AGENTS.md"].filter((value) => value !== name)) {
        expect(existsSync(join(item.agent, other))).toBe(false)
      }
    } finally {
      input.destroy()
      output.destroy()
    }
  },
  5000,
)
