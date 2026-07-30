import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

export interface SenpiDaemonRuntime {
  readonly cliPath: string
  readonly version: string
}

export function resolveSenpiDaemonRuntime(
  env: Record<string, string | undefined> = process.env,
  packagedRuntime: SenpiDaemonRuntime = resolveSenpiPackagedDaemonRuntime(),
): SenpiDaemonRuntime {
  const cliOverride = normalizeOptional(env["OMO_LSP_DAEMON_CLI"])
  const versionOverride = normalizeOptional(env["OMO_LSP_DAEMON_VERSION"])
  if ((cliOverride === undefined) !== (versionOverride === undefined)) {
    throw new Error("OMO_LSP_DAEMON_CLI and OMO_LSP_DAEMON_VERSION must be set together")
  }
  if (cliOverride === undefined || versionOverride === undefined) return packagedRuntime
  const cliPath = resolve(cliOverride)
  if (!existsSync(cliPath)) throw new Error(`Senpi LSP daemon override CLI is missing: ${cliPath}`)
  return { cliPath, version: versionOverride }
}

export function resolveSenpiPackagedDaemonRuntime(importerUrl: string = import.meta.url): SenpiDaemonRuntime {
  const cliPath = fileURLToPath(new URL("../runtime/lsp-daemon/dist/cli.js", importerUrl))
  const packageJsonPath = fileURLToPath(new URL("../runtime/lsp-daemon/dist/package.json", importerUrl))
  if (!existsSync(cliPath)) throw new Error(`Senpi packaged LSP daemon CLI is missing: ${cliPath}`)
  const parsed: unknown = JSON.parse(readFileSync(packageJsonPath, "utf8"))
  if (!isRecord(parsed) || typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error(`Senpi packaged LSP daemon version is missing: ${packageJsonPath}`)
  }
  return { cliPath, version: parsed.version }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function normalizeOptional(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : undefined
}
