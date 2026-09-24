import { existsSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"

import { log } from "./logger"
import { ACCEPTED_PACKAGE_NAMES } from "./plugin-identity"

/**
 * OpenCode installs every npm plugin into a sandbox of its own at
 * `<opencode cache>/packages/<plugin spec>/node_modules/<package>`, and its
 * `Npm.add()` returns that copy as soon as `node_modules/<package>` exists —
 * it never re-resolves the tag. A moving tag (`@latest`, `@beta`, or a bare
 * name, which OpenCode expands to `<name>@latest`) therefore stays frozen at
 * whatever version was installed first until the sandbox is gone.
 *
 * These helpers own that path layout — where a spec's sandbox lives, and
 * whether a directory really is one of our sandboxes — so the update checker
 * and the installer invalidate the same directories under the same guard.
 */

const SANDBOX_PARENT_DIR = "packages"
/**
 * Written into a sandbox to request its refresh. The request has to live on
 * disk: the thread that detects the update (the server plugin, which in the
 * TUI runs inside a Worker that never emits `exit`) is not the thread that
 * gets to run exit handlers (the TUI plugin on the main thread). OpenCode
 * ignores the file; a reinstall starts from a fresh directory without it.
 */
const REFRESH_MARKER_FILE = ".omo-refresh-pending"

export function getPluginSandboxRoot(cacheDir: string): string {
  return join(cacheDir, SANDBOX_PARENT_DIR)
}

/**
 * The spec OpenCode installs for a config plugin entry. A bare package name
 * becomes `<name>@latest`, mirroring OpenCode's own plugin-target resolution.
 * Returns null for entries that are not this plugin (`file:` dev entries and
 * third-party plugins).
 */
export function toPluginSandboxSpec(entry: string): string | null {
  const name = ACCEPTED_PACKAGE_NAMES.find((candidate) => entry === candidate || entry.startsWith(`${candidate}@`))
  if (!name) return null
  return entry === name ? `${name}@latest` : entry
}

export function getPluginSandboxDir(cacheDir: string, entry: string): string | null {
  const spec = toPluginSandboxSpec(entry)
  if (!spec) return null
  return join(getPluginSandboxRoot(cacheDir), spec)
}

function canonicalize(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/**
 * Guards every removal: true only for a direct child of
 * `<cacheDir>/packages` named after one of this plugin's package specs.
 * A plugin loaded from anywhere else — a project `node_modules`, a global
 * install, a linked checkout — must never be deleted, so a caller that walked
 * up from `import.meta.url` has to pass its result through this first.
 * Paths are canonicalized because `$TMPDIR`-style symlinks make the raw
 * strings disagree on macOS.
 */
export function isPluginSandboxDir(dir: string, cacheDir: string): boolean {
  if (toPluginSandboxSpec(basename(dir)) === null) return false
  return canonicalize(dirname(dir)) === canonicalize(getPluginSandboxRoot(cacheDir))
}

/**
 * Removes the whole sandbox directory, not just `node_modules/<package>`:
 * the sandbox's own `package.json`/lockfile can re-pin the previous version
 * when OpenCode reinstalls the spec.
 *
 * The directory is renamed aside before it is deleted. `Npm.add()` only checks
 * that `node_modules/<package>` exists, so a recursive delete that fails part
 * way (EBUSY/EPERM on a file Windows holds open, EACCES) or that races an
 * OpenCode start would leave a half-deleted copy OpenCode then loads. A rename
 * is atomic: it either fails with the sandbox intact or the spec path is gone.
 */
export function removePluginSandbox(dir: string, cacheDir: string): boolean {
  if (!isPluginSandboxDir(dir, cacheDir)) return false
  if (!existsSync(dir)) return false
  const discarded = join(dirname(dir), `.${basename(dir)}.discarded-${process.pid}-${Date.now()}`)
  renameSync(dir, discarded)
  try {
    rmSync(discarded, { recursive: true, force: true })
  } catch (error) {
    // The spec path is already gone, so the refresh took effect; what is left
    // is a dot-directory OpenCode never reads.
    if (!(error instanceof Error)) throw error
    log(`[plugin-sandbox] Refreshed ${dir}, but could not delete the discarded copy ${discarded}: ${error.message}`)
  }
  return true
}

/** Requests a refresh of our sandbox; the next exit handler that sees it removes the sandbox. */
export function markPluginSandboxStale(dir: string, cacheDir: string): boolean {
  if (!isPluginSandboxDir(dir, cacheDir)) return false
  if (!existsSync(dir)) return false
  writeFileSync(join(dir, REFRESH_MARKER_FILE), "")
  return true
}

export function isPluginSandboxMarkedStale(dir: string): boolean {
  return existsSync(join(dir, REFRESH_MARKER_FILE))
}
