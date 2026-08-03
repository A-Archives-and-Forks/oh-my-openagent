// Live-surface QA for lazycodex#6320: drive the REAL Codex install bin-linking and
// the REAL uninstall against an ISOLATED CODEX_HOME + CODEX_LOCAL_BIN_DIR, and prove
// the developer's real ~/.codex and ~/.local/bin are never touched.
//
//   bun .omo/evidence/20260803-fix-6320-uninstall-bins/live-driver.mts
import { createHash } from "node:crypto"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { linkRootRuntimeBin } from "../../../packages/omo-codex/src/install/codex-cache-bins.ts"
import { COMMAND_SHIM_MARKER, windowsCommandShim } from "../../../packages/omo-codex/src/install/codex-cache-command-shim.ts"
import { RUNTIME_WRAPPER_MARKER } from "../../../packages/omo-codex/src/install/codex-cache-runtime-wrapper.ts"
import { cleanupCodexLight } from "../../../packages/omo-codex/src/install/codex-cleanup.ts"

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path)
    return true
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as { code?: string }).code === "EISDIR") return true
    return false
  }
}

async function sha256OrAbsent(path: string): Promise<string> {
  try {
    return createHash("sha256").update(await readFile(path)).digest("hex")
  } catch {
    return "<absent>"
  }
}

async function listing(dir: string): Promise<string> {
  try {
    return (await readdir(dir)).sort().join(",")
  } catch {
    return "<absent>"
  }
}

const realCodexConfig = join(homedir(), ".codex", "config.toml")
const realLocalBin = join(homedir(), ".local", "bin")

const realConfigBefore = await sha256OrAbsent(realCodexConfig)
const realBinBefore = await listing(realLocalBin)

const codexHome = await mkdtemp(join(tmpdir(), "omo-6320-home-"))
const binDir = await mkdtemp(join(tmpdir(), "omo-6320-bin-"))
await writeFile(join(codexHome, "config.toml"), "[features]\nplugins = true\n")

// 1) REAL install: create the root omo runtime wrapper the way `lazycodex-ai install` does.
const linked = await linkRootRuntimeBin({ binDir, codexHome, repoRoot, platform: "win32" })
// A real component shim (the ulw-loop bin) written with the installer's real generator.
const componentBin = join(binDir, "omo-ulw-loop.cmd")
await writeFile(componentBin, windowsCommandShim(join(codexHome, "plugins", "cache", "sisyphuslabs", "omo", "1.0.0", "components", "ulw-loop", "dist", "cli.js")))
// A user-authored omo that is NOT ours - must survive uninstall.
const userBin = join(binDir, "omo-user.cmd")
await writeFile(userBin, "@echo off\r\necho my own tool\r\n")

const rootBin = linked?.path ?? join(binDir, "omo.cmd")
const rootContent = await readFile(rootBin, "utf8")

const before = {
  rootBinPath: rootBin.replace(binDir, "<BIN>"),
  rootBinExists: await exists(rootBin),
  rootBinHasMarker: rootContent.includes(RUNTIME_WRAPPER_MARKER),
  componentExists: await exists(componentBin),
  componentHasMarker: (await readFile(componentBin, "utf8")).includes(COMMAND_SHIM_MARKER),
  userBinExists: await exists(userBin),
}

// 2) REAL uninstall.
const result = await cleanupCodexLight({ codexHome, binDir, platform: "win32", projectDirectory: codexHome })

const after = {
  rootBinExists: await exists(rootBin),
  componentExists: await exists(componentBin),
  userBinExists: await exists(userBin),
  removedBinLinks: result.removedBinLinks.map((path) => path.replace(binDir, "<BIN>")),
}

const realConfigAfter = await sha256OrAbsent(realCodexConfig)
const realBinAfter = await listing(realLocalBin)

const pass =
  before.rootBinExists &&
  before.rootBinHasMarker &&
  before.componentExists &&
  before.userBinExists &&
  !after.rootBinExists &&
  !after.componentExists &&
  after.userBinExists &&
  result.removedBinLinks.includes(rootBin) &&
  result.removedBinLinks.includes(componentBin) &&
  !result.removedBinLinks.includes(userBin) &&
  realConfigBefore === realConfigAfter &&
  realBinBefore === realBinAfter

console.log(
  JSON.stringify(
    {
      scenario: "real linkRootRuntimeBin install -> real cleanupCodexLight uninstall, isolated CODEX_HOME + CODEX_LOCAL_BIN_DIR (win32)",
      before,
      after,
      isolation: {
        realCodexConfigUnchanged: realConfigBefore === realConfigAfter,
        realLocalBinUnchanged: realBinBefore === realBinAfter,
        realConfigSha: `${realConfigBefore.slice(0, 12)}...`,
      },
      result: pass ? "PASS" : "FAIL",
    },
    null,
    2,
  ),
)

await rm(codexHome, { recursive: true, force: true })
await rm(binDir, { recursive: true, force: true })
process.exit(pass ? 0 : 1)
