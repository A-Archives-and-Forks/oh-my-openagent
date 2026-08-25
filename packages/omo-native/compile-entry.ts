import { createHash } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { migrateLegacyBunGlobalManifest } from "./bin/lib/legacy-bun-global-migration.js"
import { adoptLegacyFlatState, canonicalAgentDir } from "./bin/lib/agent-dir.js"
import { nearestNodeBin, readJson } from "./bin/lib/package-paths.js"
import { runDoctor } from "./bin/lib/doctor.js"
import { detectHarnesses } from "./bin/lib/setup-detect.js"
import { printSetupReport } from "./bin/lib/setup-report.js"
import { delimiter } from "node:path"

type EmbeddedFile = Blob & { name: string; arrayBuffer?: () => Promise<ArrayBuffer>; text?: () => Promise<string> }
export type EmbeddedManifestEntry = { relPath: string; sha256: string; mode: number; size: number }
export type EmbeddedManifest = { omoAiVersion: string; enginePin: string; manifestSha: string; entries: EmbeddedManifestEntry[] }

// The engine is imported via a RELATIVE string LITERAL, inlined at both import
// sites, and both properties are load-bearing:
//  - `@code-yeongyu/senpi/dist/cli.js` is not in senpi's exports map (only ".",
//    "./rpc-entry", "./client"), so the bare subpath fails exports enforcement
//    at build time.
//  - bun's bundler only traces import() whose argument is a literal: a
//    module-level const or a runtime-resolved URL (import.meta.resolve +
//    pathToFileURL) drops the entire engine graph from the binary (1 module
//    bundled instead of ≈4000) and the latter also fails to resolve inside
//    $bunfs. Do NOT refactor these two literals into an indirection.
// Probe receipts: .omo/evidence/20260825-bun-compile-release-binaries/

const earlyCommands = new Set(["install", "remove", "list", "config", "auth", "app-server"])
const selfUpdateTargets = new Set(["self", "senpi", "omo"])
const engineUpdateTargets = new Set(["--extensions", "--models"])

export function buildSenpiArgs(args: string[], execDir: string): string[] {
  const command = args[0]
  if (earlyCommands.has(command) || command === "update") return args
  return ["--extension", join(execDir, "plugin"), ...args]
}

export function versionLine(packageJson: { version: string }, enginePin: string): string {
  return `omo ${packageJson.version} (engine: senpi ${enginePin})`
}

export function updateLine(target: string): string {
  return `omo is updated via curl: curl -fsSL https://github.com/code-yeongyu/oh-my-openagent/releases/latest/download/omo-${target} -o omo && chmod +x omo`
}

export function remapSenpiEnvironment(source: NodeJS.ProcessEnv = process.env, execDir: string): NodeJS.ProcessEnv {
  const env = { ...source }
  delete env.OMO_BIN
  delete env.SENPI_BIN
  env.OMO_AGENT_TOOLKIT_BIN = join(execDir, "bin", "omo-agent-toolkit.js")
  const agentDir = canonicalAgentDir(env)
  env.OMO_CODING_AGENT_DIR = agentDir
  env.SENPI_CODING_AGENT_DIR = agentDir
  env.OMO_NATIVE = "1"
  env.SENPI_RUNTIME = process.versions.bun ? "bun" : "node"
  let displayVersion = "unknown"
  try { displayVersion = readJson(join(execDir, "package.json")).version } catch { /* test fixtures may omit the sibling manifest */ }
  env.SENPI_BRAND = JSON.stringify({
    name: "OmO", command: "omo", displayVersion,
    configDir: ".omo", flatLayout: false, envPrefix: "OMO", userAgent: "omo", originator: "omo",
    update: { packageName: "omo-ai", distTag: "beta", command: updateLine(process.platform), changelogUrl: "https://github.com/code-yeongyu/oh-my-openagent/releases" },
  })
  const binDir = nearestNodeBin(execDir)
  if (binDir) {
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH"
    env[pathKey] = env[pathKey] ? `${binDir}${delimiter}${env[pathKey]}` : binDir
    const shim = join(binDir, process.platform === "win32" ? "senpi.cmd" : "senpi")
    if (existsSync(shim)) env.SENPI_BIN = shim
  }
  env.OMO_BIN = join(execDir, "bin", "omo.js")
  return env
}

async function embeddedText(file: EmbeddedFile): Promise<string> {
  if (file.text) return file.text()
  if (file.arrayBuffer) return Buffer.from(await file.arrayBuffer()).toString("utf8")
  throw new Error(`embedded asset ${file.name} cannot be read`)
}

function embeddedBytes(_file: EmbeddedFile, content: string): Uint8Array {
  return new TextEncoder().encode(content)
}

export async function provisionEmbeddedRuntime(manifest: EmbeddedManifest, embedded: EmbeddedFile[], runtimeDir: string): Promise<void> {
  mkdirSync(runtimeDir, { recursive: true })
  const marker = join(runtimeDir, ".provisioned")
  if (readFileIfExists(marker)?.trim() === manifest.manifestSha) return
  const byPath = new Map(embedded.map((file) => [file.name.replace(/^\.\//, ""), file]))
  for (const entry of manifest.entries) {
    const file = byPath.get(entry.relPath.replace(/^\.\//, ""))
    if (!file) throw new Error(`embedded asset missing: ${entry.relPath}`)
    const content = await embeddedText(file)
    const bytes = embeddedBytes(file, content)
    if (bytes.byteLength !== entry.size || createHash("sha256").update(bytes).digest("hex") !== entry.sha256) {
      throw new Error(`embedded asset integrity mismatch: ${entry.relPath}`)
    }
    const destination = join(runtimeDir, entry.relPath)
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, bytes, { mode: entry.mode })
    chmodSync(destination, entry.mode)
  }
  writeFileSync(marker, `${manifest.manifestSha}\n`, { mode: 0o644 })
}

function readFileIfExists(path: string): string | undefined {
  try { return readFileSync(path, "utf8") } catch { return undefined }
}

function isSelfUpdate(args: string[]): boolean {
  if (args[0] !== "update") return false
  const rest = args.slice(1)
  if (rest.length === 0) return true
  if (rest.some((arg) => engineUpdateTargets.has(arg))) return false
  return rest.every((arg) => arg.startsWith("-") || selfUpdateTargets.has(arg))
}

export async function runCompiledLauncher(args: string[], execDir: string, enginePin?: string): Promise<boolean> {
  const packageJson = readJson(join(execDir, "package.json"))
  enginePin ??= readJson(join(execDir, "node_modules", "@code-yeongyu", "senpi", "package.json")).version
  migrateLegacyBunGlobalManifest(execDir)
  adoptLegacyFlatState()
  const command = args[0]
  if (command === "ulw-loop") { spawn(process.execPath, [join(execDir, "plugin/runtime/agent-toolkit/ulw-loop/cli.js"), ...args.slice(1)], { stdio: "inherit" }); return true }
  if (command === "doctor") { runDoctor(await detectHarnesses()); return true }
  if (command === "setup") { printSetupReport(await detectHarnesses()); process.exitCode = 0; return true }
  if ((command === "--version" || command === "-v") && args.length === 1) { console.log(versionLine(packageJson, enginePin ?? "unknown")); return true }
  if (isSelfUpdate(args)) { console.log(updateLine(process.platform)); return true }
  return false
}

async function main(): Promise<void> {
  const embedded = (globalThis as typeof globalThis & { Bun?: { embeddedFiles?: EmbeddedFile[] } }).Bun?.embeddedFiles as EmbeddedFile[] | undefined
  if (!embedded?.length) {
    const execDir = dirname(fileURLToPath(import.meta.url))
    if (await runCompiledLauncher(process.argv.slice(2), execDir)) return
    process.argv.splice(2, process.argv.length - 2, ...buildSenpiArgs(process.argv.slice(2), execDir))
    Object.assign(process.env, remapSenpiEnvironment(process.env, execDir))
    await import("../../node_modules/@code-yeongyu/senpi/dist/cli.js") // literal: see import note above
    return
  }
  const manifestFile = embedded.find((file) => file.name.endsWith("runtime-manifest.json"))
  if (!manifestFile) throw new Error("embedded runtime-manifest.json is missing")
  const manifest = JSON.parse(await embeddedText(manifestFile)) as EmbeddedManifest
  const expected = join(homedir(), ".omo", "binary-runtime", manifest.omoAiVersion, process.platform === "win32" ? "omo.exe" : "omo")
  if (resolve(process.execPath) !== resolve(expected)) {
    await provisionEmbeddedRuntime(manifest, embedded, dirname(expected))
    writeFileSync(expected, readFileSync(process.execPath))
    chmodSync(expected, 0o755)
    const child = spawn(expected, process.argv.slice(2), { env: process.env, stdio: "inherit" })
    await new Promise<void>((resolvePromise) => child.on("close", (code) => { process.exitCode = code ?? 1; resolvePromise() }))
    return
  }
  // Inspector and custom execArgv isolation is unsupported in compiled binaries; the provisioned
  // executable delegates to the engine in-process as required by the native startup contract.
  if (await runCompiledLauncher(process.argv.slice(2), dirname(process.execPath), manifest.enginePin)) return
  process.argv.splice(2, process.argv.length - 2, ...buildSenpiArgs(process.argv.slice(2), dirname(process.execPath)))
  Object.assign(process.env, remapSenpiEnvironment(process.env, dirname(process.execPath)))
  await import("../../node_modules/@code-yeongyu/senpi/dist/cli.js") // literal: see import note above
}

if (import.meta.main) await main()
