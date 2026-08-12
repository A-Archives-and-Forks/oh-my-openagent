#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { builtinModules } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import {
  artifactsMatch,
  attachBuildMarker,
  normalizeBuiltinImports,
  toPortableBuildPath,
} from "./build-artifact.mjs"

export { toPortableBuildPath }

// Keep this list byte-for-byte aligned with senpi loader.ts lines 145-165.
export const SENPI_LOADER_ALIASES = [
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-tui",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-ai/compat",
  "@earendil-works/pi-ai/oauth",
  "@code-yeongyu/senpi",
  "@mariozechner/pi-coding-agent",
  "@mariozechner/pi-agent-core",
  "@mariozechner/pi-tui",
  "@mariozechner/pi-ai",
  "@mariozechner/pi-ai/compat",
  "@mariozechner/pi-ai/oauth",
  "typebox",
  "typebox/compile",
  "typebox/value",
  "@sinclair/typebox",
  "@sinclair/typebox/compile",
  "@sinclair/typebox/value",
]

const scriptDir = dirname(fileURLToPath(import.meta.url))
const pluginRoot = dirname(scriptDir)
const packageRoot = dirname(pluginRoot)
const repoRoot = join(packageRoot, "..", "..")
const entryPath = join(packageRoot, "src", "extension", "bundled-index.ts")
const outputPath = join(pluginRoot, "extensions", "omo.js")
const taskEntryPath = join(packageRoot, "src", "extension", "omo-task.ts")
const taskOutputPath = join(pluginRoot, "extensions", "omo-task.js")
const memberEntryPath = join(repoRoot, "packages", "senpi-task", "src", "team", "member-extension", "index.ts")
const memberOutputPath = join(pluginRoot, "extensions", "omo-member.js")
const memoryMcpEntryPath = join(packageRoot, "src", "mcp", "memory-server.ts")
const memoryMcpOutputPath = join(pluginRoot, "extensions", "omo-memory-mcp.js")
const advisorRuntimeEntryPath = join(packageRoot, "src", "components", "init-deep-advisor", "runtime.ts")
const advisorRuntimeOutputPath = join(pluginRoot, "extensions", "omo-init-deep-advisor.js")
const reflectionPersonaSource = join(repoRoot, "packages", "memory-core", "src", "reflection", "assets", "reflection-persona.md")
const builtinModuleNames = builtinModules
  .filter((moduleName) => !moduleName.startsWith("_"))
  .sort()
const externalSpecifiers = [
  "#omo-task-runtime",
  ...SENPI_LOADER_ALIASES,
  ...builtinModuleNames,
  ...builtinModuleNames.map((moduleName) => `node:${moduleName}`),
]
const BUILD_SETTINGS = JSON.stringify({
  target: "node",
  format: "esm",
  minify: true,
  loaderAliases: SENPI_LOADER_ALIASES,
})

export async function buildExtension(options = {}) {
  const packageManifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"))
  if (typeof packageManifest.version !== "string" || packageManifest.version.length === 0) {
    throw new Error("omo-senpi package manifest must contain a version")
  }
  const buildDefines = {
    OMO_SENPI_PACKAGE_VERSION: packageManifest.version,
    OMO_SENPI_BUNDLED: true,
  }
  const output = options.outputPath ?? outputPath
  const taskOutput = options.taskOutputPath ?? (options.outputPath === undefined
    ? taskOutputPath
    : join(dirname(output), "omo-task.js"))
  const memberOutput = options.memberOutputPath ?? (options.outputPath === undefined
    ? memberOutputPath
    : join(dirname(output), "omo-member.js"))
  const memoryMcpOutput = options.memoryMcpOutputPath ?? (options.outputPath === undefined
    ? memoryMcpOutputPath
    : join(dirname(output), "omo-memory-mcp.js"))
  const advisorRuntimeOutput = options.advisorRuntimeOutputPath ?? (options.outputPath === undefined
    ? advisorRuntimeOutputPath
    : join(dirname(output), "omo-init-deep-advisor.js"))
  const mainInputs = await buildEntry(entryPath, output, buildDefines)
  const taskInputs = await buildEntry(taskEntryPath, taskOutput, buildDefines)
  const memberInputs = await buildEntry(memberEntryPath, memberOutput, buildDefines)
  const memoryMcpInputs = await buildEntry(memoryMcpEntryPath, memoryMcpOutput, buildDefines)
  const advisorRuntimeInputs = await buildEntry(advisorRuntimeEntryPath, advisorRuntimeOutput, buildDefines)
  // Bundling inlines assets.ts but its markdown is read from disk at runtime next to the bundle,
  // so the persona must be staged into the extension output directory the loader executes from.
  await writeFile(join(dirname(output), "reflection-persona.md"), await readFile(reflectionPersonaSource, "utf8"))
  return { mainInputs, taskInputs, memberInputs, memoryMcpInputs, advisorRuntimeInputs }
}

async function buildEntry(entry, output, buildDefines) {
  await mkdir(dirname(output), { recursive: true })
  const metafile = `${output}.meta.json`
  try {
    run("bun", [
      "build", entry, "--target", "node", "--format", "esm", "--outfile", output,
      "--minify", `--metafile=${metafile}`,
      ...Object.entries(buildDefines).flatMap(([name, value]) => ["--define", `${name}=${JSON.stringify(value)}`]),
      ...externalSpecifiers.flatMap((specifier) => ["--external", specifier]),
    ])
    await normalizeBuiltinImports(output, builtinModuleNames)
    return await attachBuildMarker({
      output,
      entry,
      metafile,
      buildDefines,
      repoRoot,
      buildSettings: BUILD_SETTINGS,
      buildScriptPath: fileURLToPath(import.meta.url),
    })
  } finally {
    await rm(metafile, { force: true })
  }
}

export async function checkExtensionCurrent(options = {}) {
  const output = options.outputPath ?? outputPath
  const taskOutput = options.taskOutputPath ?? (options.outputPath === undefined
    ? taskOutputPath
    : join(dirname(output), "omo-task.js"))
  const memberOutput = options.memberOutputPath ?? (options.outputPath === undefined
    ? memberOutputPath
    : join(dirname(output), "omo-member.js"))
  const memoryMcpOutput = options.memoryMcpOutputPath ?? (options.outputPath === undefined
    ? memoryMcpOutputPath
    : join(dirname(output), "omo-memory-mcp.js"))
  const advisorRuntimeOutput = options.advisorRuntimeOutputPath ?? (options.outputPath === undefined
    ? advisorRuntimeOutputPath
    : join(dirname(output), "omo-init-deep-advisor.js"))
  const currentMain = await readBuiltEntry(output)
  if (currentMain === undefined) return { ok: false, reason: "missing-output", output }
  const currentTask = await readBuiltEntry(taskOutput)
  if (currentTask === undefined) return { ok: false, reason: "missing-output", output: taskOutput }
  const currentMember = await readBuiltEntry(memberOutput)
  if (currentMember === undefined) return { ok: false, reason: "missing-output", output: memberOutput }
  const currentMemoryMcp = await readBuiltEntry(memoryMcpOutput)
  if (currentMemoryMcp === undefined) return { ok: false, reason: "missing-output", output: memoryMcpOutput }
  const currentAdvisorRuntime = await readBuiltEntry(advisorRuntimeOutput)
  if (currentAdvisorRuntime === undefined) {
    return { ok: false, reason: "missing-output", output: advisorRuntimeOutput }
  }

  const tempRoot = await mkdtemp(join(repoRoot, ".build-check-"))
  const expectedOutput = join(tempRoot, "omo.js")
  const expectedTaskOutput = join(tempRoot, "omo-task.js")
  const expectedMemberOutput = join(tempRoot, "omo-member.js")
  const expectedMemoryMcpOutput = join(tempRoot, "omo-memory-mcp.js")
  const expectedAdvisorRuntimeOutput = join(tempRoot, "omo-init-deep-advisor.js")
  try {
    await buildExtension({
      outputPath: expectedOutput,
      taskOutputPath: expectedTaskOutput,
      memberOutputPath: expectedMemberOutput,
      memoryMcpOutputPath: expectedMemoryMcpOutput,
      advisorRuntimeOutputPath: expectedAdvisorRuntimeOutput,
    })
    if (!artifactsMatch(currentMain, await readFile(expectedOutput, "utf8"))) {
      return { ok: false, reason: "stale-output", output }
    }
    if (!artifactsMatch(currentTask, await readFile(expectedTaskOutput, "utf8"))) {
      return { ok: false, reason: "stale-output", output: taskOutput }
    }
    if (!artifactsMatch(currentMember, await readFile(expectedMemberOutput, "utf8"))) {
      return { ok: false, reason: "stale-output", output: memberOutput }
    }
    if (!artifactsMatch(currentMemoryMcp, await readFile(expectedMemoryMcpOutput, "utf8"))) {
      return { ok: false, reason: "stale-output", output: memoryMcpOutput }
    }
    if (!artifactsMatch(currentAdvisorRuntime, await readFile(expectedAdvisorRuntimeOutput, "utf8"))) {
      return { ok: false, reason: "stale-output", output: advisorRuntimeOutput }
    }
    const expectedPersona = await readFile(join(tempRoot, "reflection-persona.md"), "utf8")
    const currentPersona = await readFile(join(dirname(output), "reflection-persona.md"), "utf8").catch(() => undefined)
    if (currentPersona !== expectedPersona) {
      return { ok: false, reason: "stale-output", output: join(dirname(output), "reflection-persona.md") }
    }
    return { ok: true, output, taskOutput, memberOutput, advisorRuntimeOutput }
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    shell: process.platform === "win32",
    stdio: "inherit",
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function isErrno(error, code) {
  return error instanceof Error && "code" in error && error.code === code
}

async function readBuiltEntry(output) {
  try {
    return await readFile(output, "utf8")
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined
    throw error
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--check")) {
    run("node", [join(scriptDir, "stage-lsp-daemon-runtime.mjs"), "--check"])
    run("node", [join(scriptDir, "stage-ast-grep-mcp-runtime.mjs"), "--check"])
    run("node", [join(scriptDir, "stage-agent-toolkit.mjs"), "--check"])
    const result = await checkExtensionCurrent()
    if (!result.ok) {
      console.error(`omo-senpi extension build is not current: ${result.reason}`)
      console.error(`output=${result.output}`)
      process.exit(1)
    }
    console.log(`omo-senpi extension build is current: ${result.output}`)
  } else {
    await buildExtension()
    console.log(
      `Built omo-senpi extensions: ${outputPath}, ${taskOutputPath}, ${memberOutputPath}, ${advisorRuntimeOutputPath}`,
    )
  }
}
