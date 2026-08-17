import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import {
  existsSync,
  realpathSync,
  watch,
  type FSWatcher,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { tryAcquireLock } from "../packages/lsp-daemon/src/lock"

export type RunVendoredLspCommand = (
  command: string,
  args: string[],
  options: {
    cwd: string
    timeoutMs: number
  },
) => Promise<number>

export interface EnsureVendoredLspDaemonOptions {
  packageDir: string
  outputPath?: string
  timeoutMs?: number
  exists?: (path: string) => boolean
  runCommand?: RunVendoredLspCommand
  log?: (message: string) => void
  lockRoot?: string
}

const DEFAULT_TIMEOUT_MS = 300_000
const LOCK_FILE_PREFIX = "omo-test-lsp-build-"

const defaultRunCommand: RunVendoredLspCommand = async (command, args, options) => {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    stdio: ["ignore", "ignore", "inherit"],
    timeout: options.timeoutMs,
    shell: process.platform === "win32",
  })
  return result.status ?? 1
}

export async function ensureVendoredLspDaemonBuilt(
  options: EnsureVendoredLspDaemonOptions,
): Promise<void> {
  const outputPath = options.outputPath ?? join(options.packageDir, "dist", "cli.js")
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const pathExists = options.exists ?? existsSync
  const runCommand = options.runCommand ?? defaultRunCommand
  const log = options.log ?? console.error

  if (pathExists(outputPath)) {
    return
  }

  const lockPath = resolveBuildLockPath(options.packageDir, options.lockRoot ?? tmpdir())

  while (!pathExists(outputPath)) {
    const lock = tryAcquireLock(lockPath)
    if (!lock) {
      await waitForBuildTurn(lockPath, outputPath, timeoutMs, pathExists)
      continue
    }

    try {
      if (pathExists(outputPath)) {
        return
      }

      log(
        "[test-setup] vendored lsp-daemon dist missing; building once via `npm ci && npm run build`...",
      )

      const installStatus = await runCommand("npm", ["ci"], {
        cwd: options.packageDir,
        timeoutMs,
      })
      if (installStatus !== 0) {
        throw new Error(
          `[test-setup] lsp-daemon npm ci failed with exit code ${installStatus}`,
        )
      }

      const buildStatus = await runCommand("npm", ["run", "build"], {
        cwd: options.packageDir,
        timeoutMs,
      })
      if (buildStatus !== 0) {
        throw new Error(
          `[test-setup] lsp-daemon build failed with exit code ${buildStatus}`,
        )
      }
      if (!pathExists(outputPath)) {
        throw new Error(
          `[test-setup] lsp-daemon build completed without ${outputPath}`,
        )
      }
      return
    } finally {
      lock.release()
    }
  }
}

function resolveBuildLockPath(packageDir: string, lockRoot: string): string {
  const packagePath = realpathSync.native(packageDir)
  const digest = createHash("sha256").update(packagePath).digest("hex").slice(0, 20)
  return join(lockRoot, `${LOCK_FILE_PREFIX}${digest}.lock`)
}

async function waitForBuildTurn(
  lockPath: string,
  outputPath: string,
  timeoutMs: number,
  pathExists: (path: string) => boolean,
): Promise<void> {
  if (pathExists(outputPath) || !pathExists(lockPath)) {
    return
  }

  await new Promise<void>((resolve, reject) => {
    let watcher: FSWatcher | undefined
    let settled = false

    const settle = (error?: Error) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      watcher?.close()
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    }

    const checkState = () => {
      if (pathExists(outputPath) || !pathExists(lockPath)) {
        settle()
      }
    }

    const timeout = setTimeout(() => {
      settle(new Error(`[test-setup] timed out waiting for ${basename(outputPath)}`))
    }, timeoutMs)

    watcher = watch(dirname(lockPath), { persistent: false }, (_event, filename) => {
      if (filename === null || filename.toString() === basename(lockPath)) {
        checkState()
      }
    })

    checkState()
  })
}


