import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export async function runDetachedProbe(scenario: string): Promise<{
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly sandboxRemoved: boolean
}> {
  const sandbox = mkdtempSync(join(tmpdir(), "omo-detached-probe-"))
  const env: NodeJS.ProcessEnv = {
    ...process.env, HOME: sandbox, USERPROFILE: sandbox, TMPDIR: sandbox, TMP: sandbox, TEMP: sandbox,
  }
  for (const prefix of ["OMO", "SENPI", "PI"]) {
    const dir = join(sandbox, prefix.toLowerCase())
    mkdirSync(dir)
    env[`${prefix}_CODING_AGENT_DIR`] = dir
  }
  for (const key of [
    "SENPI_PACKAGE_DIR", "OMO_PACKAGE_DIR", "PI_PACKAGE_DIR", "OMO_BIN", "SENPI_BIN",
    "PI_SESSION_FILE", "OMO_RPC_SOCKET_PATH",
  ]) delete env[key]
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "detached-process.test-support.ts"), scenario], {
    env, stdout: "pipe", stderr: "pipe",
  })
  const timeout = setTimeout(() => child.kill(), 10_000)
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ])
    return { exitCode, stdout, stderr, sandboxRemoved: true }
  } finally {
    clearTimeout(timeout)
    if (child.exitCode === null) {
      child.kill()
      await child.exited
    }
    rmSync(sandbox, { recursive: true, force: true })
    if (existsSync(sandbox)) throw new Error(`sandbox survived cleanup: ${sandbox}`)
  }
}
