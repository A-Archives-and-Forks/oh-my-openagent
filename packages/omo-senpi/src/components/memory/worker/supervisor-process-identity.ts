import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"

async function readCommand(command: string, args: readonly string[]): Promise<string | null> {
  return await new Promise((resolve) => {
    execFile(command, [...args], { encoding: "utf8", timeout: 2_000 }, (error, stdout) => {
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
    const fields = stat.slice(commandEnd + 2).trim().split(/\s+/)
    const startTicks = fields[19]
    return startTicks === undefined ? null : `linux-proc-start-ticks:${startTicks}`
  } catch {
    return null
  }
}

export async function getSupervisorProcessStart(pid: number): Promise<string | null> {
  if (process.platform === "linux") return await readLinuxStartIdentity(pid)
  if (process.platform === "darwin" || process.platform === "freebsd") {
    const value = await readCommand("/bin/ps", ["-o", "lstart=", "-p", String(pid)])
    return value === null ? null : `ps-lstart:${value.replace(/\s+/g, " ")}`
  }
  return null
}
