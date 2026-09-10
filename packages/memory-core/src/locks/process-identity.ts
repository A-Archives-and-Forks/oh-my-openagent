import { execFile } from "node:child_process"
import { readFile } from "../fs/resilient"
import { readDarwinProcessLstart } from "./process-start-time"

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !("code" in error)) return undefined
  return typeof error.code === "string" ? error.code : undefined
}

async function execFileText(command: string, args: string[]): Promise<string | null> {
  return await new Promise((resolve) => {
    execFile(command, args, { encoding: "utf8", timeout: 2_000 }, (error, stdout) => {
      if (error !== null) {
        resolve(null)
        return
      }
      const value = stdout.trim()
      resolve(value.length > 0 ? value : null)
    })
  })
}

async function readLinuxStartIdentity(pid: number): Promise<string | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8")
    const commandEnd = stat.lastIndexOf(")")
    if (commandEnd < 0) return null
    const fieldsAfterCommand = stat.slice(commandEnd + 2).trim().split(/\s+/)
    const startTicks = fieldsAfterCommand[19]
    return startTicks === undefined ? null : `linux-proc-start-ticks:${startTicks}`
  } catch {
    return null
  }
}

function toStartIdentity(lstart: string): string {
  return `ps-lstart:${lstart.replace(/\s+/g, " ")}`
}

export async function getProcessStartIdentity(pid: number): Promise<string | null> {
  if (process.platform === "linux") return await readLinuxStartIdentity(pid)
  if (process.platform === "darwin" || process.platform === "freebsd") {
    if (getPidLiveness(pid) === "dead") return null
    const inProcess = await readDarwinProcessLstart(pid)
    if (inProcess !== null) return toStartIdentity(inProcess)
    const value = await execFileText("/bin/ps", ["-o", "lstart=", "-p", String(pid)])
    return value === null ? null : toStartIdentity(value)
  }
  return null
}

export type ProcessLiveness = "alive" | "dead" | "unknown"

export function getPidLiveness(pid: number): ProcessLiveness {
  try {
    process.kill(pid, 0)
    return "alive"
  } catch (error) {
    const code = errorCode(error)
    if (code === "ESRCH") return "dead"
    if (code === "EPERM") return "alive"
    return "unknown"
  }
}
