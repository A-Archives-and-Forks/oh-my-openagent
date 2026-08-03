import { lstat, readFile, readdir, readlink, rm } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { COMMAND_SHIM_MARKER } from "./codex-cache-command-shim"
import { isManagedComponentBinTarget } from "./codex-cache-dangling-bins"
import { isNodeErrorWithCode } from "./codex-cache-fs"
import { RUNTIME_WRAPPER_MARKER } from "./codex-cache-runtime-wrapper"

type LinkPlatform = NodeJS.Platform

// Removes every bin link the Codex installer created in binDir - the root `omo`
// runtime wrapper plus the component shims/symlinks - so uninstall no longer
// leaves the `omo` command behind (issue #6320). Each candidate is confirmed to
// carry the installer's own marker (RUNTIME_WRAPPER_MARKER / COMMAND_SHIM_MARKER)
// or to resolve to a managed component target before removal, so a user's
// unrelated `omo` on PATH is never touched. Unlike the install-time dangling
// sweep this removes managed bins whether or not their cache target still
// exists, because uninstall also removes that cache.
export async function removeManagedCodexBins(binDir: string, platform: LinkPlatform): Promise<readonly string[]> {
  const entries = await readdir(binDir, { withFileTypes: true }).catch((error: unknown) => {
    if (isNodeErrorWithCode(error) && error.code === "ENOENT") return null
    throw error
  })
  if (entries === null) return []

  const removed: string[] = []
  for (const entry of entries) {
    const linkPath = join(binDir, entry.name)
    if (await isManagedCodexBin(linkPath, platform)) {
      await rm(linkPath, { force: true })
      removed.push(linkPath)
    }
  }
  return removed
}

async function isManagedCodexBin(linkPath: string, platform: LinkPlatform): Promise<boolean> {
  const entryStat = await lstat(linkPath).catch((error: unknown) => {
    if (isNodeErrorWithCode(error) && error.code === "ENOENT") return null
    throw error
  })
  if (entryStat === null) return false

  if (entryStat.isSymbolicLink()) {
    if (platform === "win32") return false
    const linkTarget = await readlink(linkPath)
    const target = isAbsolute(linkTarget) ? linkTarget : resolve(dirname(linkPath), linkTarget)
    return isManagedComponentBinTarget(target)
  }

  if (!entryStat.isFile()) return false
  const content = await readFile(linkPath, "utf8")
  return content.includes(RUNTIME_WRAPPER_MARKER) || content.includes(COMMAND_SHIM_MARKER)
}
