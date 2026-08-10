#!/usr/bin/env node
import { spawn } from "node:child_process"
import { closeSync, openSync, writeSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  readRunJson,
  unlinkRunArtifact,
  updateRunLedger,
  writeRunJsonAtomic,
  type RunLaunchManifest,
  type RunOutcome,
} from "./run-artifacts"
import { getSupervisorProcessStart } from "./supervisor-process-identity"

interface ChildExit {
  readonly code: number | null
  readonly signal: string | null
}

async function readRelease(): Promise<boolean> {
  for await (const chunk of process.stdin) {
    if (Buffer.byteLength(chunk) > 0) return true
  }
  return false
}

function writeBootstrapStatus(status: ChildExit): void {
  try {
    writeSync(3, `${JSON.stringify(status)}\n`)
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || !["EPIPE", "EBADF"].includes(String(error.code))) {
      throw error
    }
  }
}

async function runChildBootstrap(runDir: string): Promise<void> {
  if (!(await readRelease())) return
  const manifest = await readRunJson<RunLaunchManifest>(join(runDir, "launch.json"))
  const child = spawn(manifest.command, [...manifest.args], {
    cwd: manifest.cwd,
    env: manifest.env,
    detached: false,
    stdio: ["ignore", "inherit", "inherit"],
  })
  process.on("SIGTERM", () => undefined)
  process.on("SIGINT", () => undefined)
  const status = await new Promise<ChildExit>((resolve) => {
    let settled = false
    child.once("error", () => {
      if (settled) return
      settled = true
      resolve({ code: null, signal: null })
    })
    child.once("close", (code, signal) => {
      if (settled) return
      settled = true
      resolve({ code, signal })
    })
  })
  writeBootstrapStatus(status)
}

function signalProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return
  try {
    if (process.platform === "win32") process.kill(pid, signal)
    else process.kill(-pid, signal)
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error
  }
}

function parseBootstrapStatus(text: string): ChildExit | undefined {
  const line = text.trim().split("\n").at(-1)
  if (line === undefined || line.length === 0) return undefined
  try {
    const value = JSON.parse(line) as Record<string, unknown>
    const code = typeof value.code === "number" || value.code === null ? value.code : undefined
    const signal = typeof value.signal === "string" || value.signal === null ? value.signal : undefined
    return code === undefined || signal === undefined ? undefined : { code, signal }
  } catch {
    return undefined
  }
}

async function runSupervisor(runDir: string): Promise<void> {
  const launchPath = join(runDir, "launch.json")
  const ledgerPath = join(runDir, "ledger.json")
  const outcomePath = join(runDir, "outcome.json")
  const manifest = await readRunJson<RunLaunchManifest>(launchPath)

  await updateRunLedger(ledgerPath, {
    pid: process.pid,
    processStart: await getSupervisorProcessStart(process.pid),
  })

  const stdoutFd = openSync(manifest.stdoutPath, "w")
  const stderrFd = openSync(manifest.stderrPath, "w")
  const bootstrap = spawn(process.execPath, [fileURLToPath(import.meta.url), "--child-bootstrap", runDir], {
    cwd: manifest.cwd,
    env: process.env,
    detached: true,
    stdio: ["pipe", stdoutFd, stderrFd, "pipe"],
  })
  let childGroupPid = bootstrap.pid
  let bootstrapStatus = ""
  const control = bootstrap.stdio[3]
  if (control !== undefined && control !== null && "setEncoding" in control) {
    control.setEncoding("utf8")
    control.on("data", (chunk: string) => { bootstrapStatus += chunk })
  }

  const containChild = () => {
    try {
      signalProcessGroup(childGroupPid, "SIGKILL")
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    }
  }
  process.once("exit", containChild)
  process.once("SIGTERM", () => {
    containChild()
    childGroupPid = undefined
    process.exit(143)
  })
  process.once("SIGINT", () => {
    containChild()
    childGroupPid = undefined
    process.exit(130)
  })

  if (bootstrap.pid === undefined) throw new Error("child bootstrap did not receive a pid")
  await updateRunLedger(ledgerPath, {
    childPid: bootstrap.pid,
    childProcessStart: await getSupervisorProcessStart(bootstrap.pid),
  })
  bootstrap.stdin?.end("1\n")

  let timedOut = false
  let escalation: ReturnType<typeof setTimeout> | undefined
  const deadline = setTimeout(() => {
    timedOut = true
    signalProcessGroup(childGroupPid, "SIGTERM")
    const killDelay = Math.max(0, manifest.hardDeadlineAt + manifest.terminationGraceMs - Date.now())
    escalation = setTimeout(() => signalProcessGroup(childGroupPid, "SIGKILL"), killDelay)
  }, Math.max(0, manifest.hardDeadlineAt - Date.now()))

  const wrapperExit = await new Promise<ChildExit>((resolve, reject) => {
    let settled = false
    bootstrap.once("error", (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
    bootstrap.once("close", (code, signal) => {
      if (settled) return
      settled = true
      resolve({ code, signal })
    })
  }).finally(() => {
    clearTimeout(deadline)
    if (escalation !== undefined) clearTimeout(escalation)
    childGroupPid = undefined
    closeSync(stdoutFd)
    closeSync(stderrFd)
  })

  const outcome: RunOutcome = {
    version: 1,
    runId: manifest.runId,
    finishedAt: new Date().toISOString(),
    childExit: parseBootstrapStatus(bootstrapStatus) ?? wrapperExit,
    timedOut,
  }
  await writeRunJsonAtomic(outcomePath, outcome)
  await unlinkRunArtifact(launchPath)
}

const args = process.argv.slice(2)
try {
  if (args[0] === "--child-bootstrap") {
    if (args[1] === undefined) throw new TypeError("run directory is required")
    await runChildBootstrap(args[1])
  } else {
    if (args[0] === undefined) throw new TypeError("run directory is required")
    await runSupervisor(args[0])
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
}
