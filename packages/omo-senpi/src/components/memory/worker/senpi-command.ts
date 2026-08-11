import { existsSync, realpathSync } from "node:fs"
import { createRequire } from "node:module"
import { delimiter, dirname, isAbsolute, join, sep } from "node:path"

import { detectBunBinary, resolveSenpiExecutable } from "@oh-my-opencode/senpi-task"

const SENPI_PACKAGE_DIR = join("@code-yeongyu", "senpi")
const CLI_RELATIVE = join("dist", "cli.js")

/**
 * Resolve the senpi CLI to spawn reflection, dream, and facts children with.
 *
 * The previous resolution ended at a bare `"senpi"` when no executable was found, which is not a
 * runnable command: a senpi launched from an environment whose PATH lacks the senpi bin directory
 * produced children that died with `execvp() of 'senpi' failed: No such file or directory`, so
 * every background memory run failed while the parent session looked healthy.
 *
 * A PATH scan cannot be the last resort because the child inherits the same PATH that already
 * failed. This extension only ever runs inside senpi, so the running installation is authoritative:
 * resolve the CLI through the senpi module that loaded us and fall back to the interpreter that is
 * executing this process. Both are absolute paths, so the spawn no longer depends on PATH at all.
 */
export function resolveSenpiCommand(env: NodeJS.ProcessEnv): string {
  const executable = resolveSenpiExecutable({
    isBunBinary: detectBunBinary(import.meta.url),
    execPath: process.execPath,
    platform: process.platform,
    parentEnv: env,
    resolveRpcEntry: () => "",
  })
  if (executable !== null) return executable
  return resolveInstalledSenpiCli() ?? process.execPath
}

/**
 * Locate `<senpi package>/dist/cli.js` for the installation that loaded this extension. The senpi
 * package blocks `./package.json` in its `exports` map, so the manifest cannot be resolved directly;
 * the module search paths are walked instead. A PATH-discovered launcher is followed through its
 * symlink because the published `bin` entry is that same `dist/cli.js`.
 */
function resolveInstalledSenpiCli(): string | null {
  const require = createRequire(import.meta.url)
  for (const modulesDir of require.resolve.paths(join(SENPI_PACKAGE_DIR, "package.json")) ?? []) {
    const candidate = join(modulesDir, SENPI_PACKAGE_DIR, CLI_RELATIVE)
    if (existsSync(candidate)) return candidate
  }
  return resolveLauncherTarget()
}

function resolveLauncherTarget(): string | null {
  const name = process.platform === "win32" ? "senpi.exe" : "senpi"
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir.length === 0) continue
    const candidate = join(dir, name)
    if (!existsSync(candidate)) continue
    const target = safeRealpath(candidate)
    if (target !== null && target.endsWith(`${sep}${CLI_RELATIVE}`)) return target
    return candidate
  }
  return null
}

function safeRealpath(path: string): string | null {
  try {
    const resolved = realpathSync(path)
    return isAbsolute(resolved) ? resolved : join(dirname(path), resolved)
  } catch {
    return null
  }
}
