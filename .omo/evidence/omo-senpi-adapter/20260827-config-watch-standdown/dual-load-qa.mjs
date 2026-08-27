#!/usr/bin/env node
// Change-scoped live QA for the config-watch duplicate-load fix (PR #7420).
// Reuses the sanctioned isolation harness from packages/omo-senpi/scripts/qa/drive.mjs:
// every lane runs the REAL senpi binary against its own throwaway SENPI_CODING_AGENT_DIR
// with the local mock provider (PI_OFFLINE=1, no real API call, no real credentials).
//
// Lanes:
//   lane1-single-load : one fixed plugin via settings packages        -> healthy session, no stand-down
//   lane2-dual-fixed  : fixed plugin via packages + fixed copy via -e -> stand-down warning, session completes
//   lane3-dual-prefix : PRE-FIX bundle in both positions              -> reproduces the reported RangeError
//
// Lane 3 is the failing-first proof: the pre-fix bundle is extracted from the PR's
// parent commit (git show HEAD~1:packages/omo-senpi/plugin/extensions/omo.js).
import { execFileSync, spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, "..", "..", "..", "..")
const qaDir = join(repoRoot, "packages", "omo-senpi", "scripts", "qa")
const pluginRoot = join(repoRoot, "packages", "omo-senpi", "plugin")
const mockProviderEntry = join(qaDir, "mock-provider", "index.ts")
const senpiBin = process.env.SENPI_BIN?.trim() || join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "senpi.exe" : "senpi")

const { createSandbox, seedSandbox, credentialDigest } = await import(pathToFileURL(join(qaDir, "drive.mjs")).href)

const STANDDOWN = "superseded by another omo extension instance; standing down"
const RANGE_ERROR = "Maximum call stack size exceeded"

function makePluginCopy(targetDir, bundleSource) {
  mkdirSync(join(targetDir, "extensions"), { recursive: true })
  const manifest = JSON.parse(readFileSync(join(pluginRoot, "package.json"), "utf8"))
  writeFileSync(join(targetDir, "package.json"), JSON.stringify(manifest, null, 2))
  cpSync(join(pluginRoot, "skills"), join(targetDir, "skills"), { recursive: true })
  writeFileSync(join(targetDir, "extensions", "omo.js"), bundleSource)
}

function runLane(name, { packagesPlugin, extraExtension, expect }) {
  const sandbox = createSandbox()
  try {
    seedSandbox(sandbox)
    // Point the settings packages entry at this lane's plugin copy instead of the repo plugin.
    writeFileSync(
      join(sandbox.agentDir, "settings.json"),
      `${JSON.stringify({ defaultProjectTrust: "ask", packages: [packagesPlugin] }, null, 2)}\n`,
    )
    writeFileSync(
      join(sandbox.cwd, "mock-script.json"),
      `${JSON.stringify({ steps: [{ type: "text", text: `${name} complete` }] }, null, 2)}\n`,
    )
    const args = ["-e", mockProviderEntry]
    if (extraExtension !== undefined) args.push("-e", extraExtension)
    args.push("-p", "--provider", "omo-mock", "--model", "mock-1", `${name} prompt`)
    const run = spawnSync(senpiBin, args, {
      cwd: sandbox.cwd,
      env: {
        ...process.env,
        OMO_CODING_AGENT_DIR: sandbox.agentDir,
        SENPI_CODING_AGENT_DIR: sandbox.agentDir,
        PI_CODING_AGENT_DIR: sandbox.agentDir,
        HOME: sandbox.homeDir,
        USERPROFILE: sandbox.homeDir,
        XDG_CONFIG_HOME: sandbox.xdgConfigHome,
        XDG_DATA_HOME: sandbox.xdgDataHome,
        XDG_CACHE_HOME: sandbox.xdgCacheHome,
        PI_OFFLINE: "1",
        OMO_SENPI_QA: "1",
      },
      encoding: "utf8",
      timeout: 120_000,
    })
    const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`
    writeFileSync(join(scriptDir, `${name}.output.txt`), output)
    const observed = {
      status: run.status,
      signal: run.signal ?? null,
      standDown: output.includes(STANDDOWN),
      rangeError: output.includes(RANGE_ERROR),
      sandboxAgentDir: sandbox.agentDir,
    }
    // `status` is recorded but only asserted when the lane expects one: senpi
    // exits 0 even from the uncaughtException handler, so the crash lane pins
    // the RangeError text instead of the exit code.
    const pass =
      (expect.status === undefined || observed.status === expect.status) &&
      observed.standDown === expect.standDown &&
      observed.rangeError === expect.rangeError
    return { name, result: pass ? "PASS" : "FAIL", expect, observed }
  } finally {
    rmSync(sandbox.root, { recursive: true, force: true })
  }
}

const realSenpiAgentDir = join(homedir(), ".senpi", "agent")
const realOmoAgentDir = join(homedir(), ".omo", "agent")
const before = {
  senpiAgentCredentials: credentialDigest(realSenpiAgentDir),
  omoAgentCredentials: credentialDigest(realOmoAgentDir),
}

const stage = join(scriptDir, ".stage")
rmSync(stage, { recursive: true, force: true })
const fixedBundle = readFileSync(join(pluginRoot, "extensions", "omo.js"), "utf8")
const prefixBundle = execFileSync("git", ["show", "HEAD~1:packages/omo-senpi/plugin/extensions/omo.js"], {
  cwd: repoRoot,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
})
if (prefixBundle.includes("standing down")) throw new Error("pre-fix bundle unexpectedly contains the fix")
if (!fixedBundle.includes("standing down")) throw new Error("fixed bundle is missing the fix")
const copies = {
  fixedA: join(stage, "fixed-a"),
  fixedB: join(stage, "fixed-b"),
  prefixA: join(stage, "prefix-a"),
  prefixB: join(stage, "prefix-b"),
}
makePluginCopy(copies.fixedA, fixedBundle)
makePluginCopy(copies.fixedB, fixedBundle)
makePluginCopy(copies.prefixA, prefixBundle)
makePluginCopy(copies.prefixB, prefixBundle)

if (!existsSync(senpiBin)) {
  console.log(JSON.stringify({ result: "SKIP", reason: "senpi-binary-unavailable", senpiBin }))
  process.exit(1)
}

const lanes = [
  runLane("lane1-single-load", {
    packagesPlugin: copies.fixedA,
    expect: { status: 0, standDown: false, rangeError: false },
  }),
  runLane("lane2-dual-fixed", {
    packagesPlugin: copies.fixedA,
    extraExtension: copies.fixedB,
    expect: { status: 0, standDown: true, rangeError: false },
  }),
  runLane("lane3-dual-prefix", {
    packagesPlugin: copies.prefixA,
    extraExtension: copies.prefixB,
    expect: { standDown: false, rangeError: true },
  }),
]

rmSync(stage, { recursive: true, force: true })
const after = {
  senpiAgentCredentials: credentialDigest(realSenpiAgentDir),
  omoAgentCredentials: credentialDigest(realOmoAgentDir),
}
const summary = {
  result: lanes.every((lane) => lane.result === "PASS") ? "PASS" : "FAIL",
  senpiBin,
  lanes,
  realSenpiUntouched: before.senpiAgentCredentials === after.senpiAgentCredentials,
  realOmoAgentUntouched: before.omoAgentCredentials === after.omoAgentCredentials,
}
writeFileSync(join(scriptDir, "final.json"), `${JSON.stringify(summary, null, 2)}\n`)
console.log(JSON.stringify(summary, null, 2))
process.exit(summary.result === "PASS" ? 0 : 1)
