import { afterEach, beforeAll, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { teardownRoots } from "./teardown.test-support"
import { buildMigrationRuntime } from "../../../script/build-migration-runtime"

const roots: string[] = []
beforeAll(buildMigrationRuntime)
afterEach(() => teardownRoots(roots))

test("#given a compiled setup importer #when credentials are imported #then bundled provider aliases resolve", () => {
  const root = mkdtempSync(join(tmpdir(), "omo-setup-compiled-"))
  roots.push(root)
  const home = join(root, "home")
  const data = join(root, "data")
  const agentDir = join(root, "agent")
  mkdirSync(home)
  mkdirSync(join(data, "opencode"), { recursive: true })
  writeFileSync(join(data, "opencode", "auth.json"), JSON.stringify({
    "anthropic-api": { type: "api", key: "DUMMY_COMPILED_KEY" },
  }))
  const entry = join(root, "entry.js")
  const source = fileURLToPath(new URL("../bin/lib/setup-import.js", import.meta.url))
  writeFileSync(entry, `import { runSetup } from ${JSON.stringify(source)};\nawait runSetup(["--yes"]);\n`)
  const binary = join(root, process.platform === "win32" ? "setup.exe" : "setup")
  const build = spawnSync(process.execPath, ["build", entry, "--compile", "--outfile", binary], { encoding: "utf8" })
  expect(build.status, build.stderr).toBe(0)

  const result = spawnSync(binary, [], {
    encoding: "utf8",
    cwd: home,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      USERPROFILE: home,
      OMO_CODING_AGENT_DIR: agentDir,
      SENPI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_DIR: agentDir,
      XDG_DATA_HOME: data,
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_STATE_HOME: join(root, "state"),
      XDG_CACHE_HOME: join(root, "cache"),
    },
  })

  expect(result.status, result.stderr).toBe(0)
  expect(JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8"))).toEqual({
    anthropic: { type: "api_key", key: "DUMMY_COMPILED_KEY" },
  })
})
