// Bounded liveness primitives for tests that spawn real helper processes: zombie-aware pid
// probes, pid-file readers for foreign (non-child) writers, bounded child-termination waits,
// and fail-safe kills so a failed assertion can never leak a spawned process.

import { readFileSync, watch } from "node:fs"
import { readFile } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import { dirname, basename } from "node:path"
import type { ChildProcess } from "node:child_process"

/**
 * Resolves true once the child TERMINATED (`exit`, or the later `close`), false once `boundMs`
 * elapsed. Deliberately NOT gated on stdio close alone: `close` lags `exit` indefinitely when a
 * descendant inherited the child's stdio fds, and teardown must never stall - or report a false
 * "survived teardown" - behind pipes that carry no liveness of their own.
 */
export function exitedWithin(child: ChildProcess, boundMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => settle(false), boundMs)
    function settle(exited: boolean): void {
      clearTimeout(timer)
      child.off("exit", onDone)
      child.off("close", onDone)
      resolve(exited)
    }
    function onDone(): void {
      settle(true)
    }
    child.once("exit", onDone)
    child.once("close", onDone)
  })
}

export function pidAlive(pid: number): boolean {
  if (process.platform === "linux") {
    try {
      const statLine = readFileSync(`/proc/${String(pid)}/stat`, "utf8")
      const stateIndex = statLine.lastIndexOf(")") + 2
      // Z = zombie: exited but unreaped; signal liveness still succeeds against it.
      if (statLine.slice(stateIndex, stateIndex + 1) === "Z") return false
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return false
      // Unreadable /proc entry: fall through to signal liveness.
    }
  }
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // ESRCH means the process is gone; anything else (EPERM, ...) means it still exists.
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false
    return true
  }
}

/** Resolves true once the pid is provably terminal (dead or zombie), false once `boundMs` elapsed. */
export type ProcessIdentity = Readonly<{ pid: number; command: string }>

function commandForPid(pid: number): string | null {
  try {
    if (process.platform === "linux") return readFileSync(`/proc/${String(pid)}/cmdline`, "utf8").replaceAll("\\0", " ").trim()
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).trim()
  } catch {
    return null
  }
}

export function waitForFileEvent(path: string, boundMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const watcher = watch(dirname(path), (_event, name) => {
      if (name !== basename(path)) return
      void readFile(path).then(() => { clearTimeout(timer); watcher.close(); resolve() }).catch(() => undefined)
    })
    const timer = setTimeout(() => { watcher.close(); reject(new Error(`file event never arrived for ${path}`)) }, boundMs)
  })
}

export function identityMatches(identity: ProcessIdentity): boolean {
  const command = commandForPid(identity.pid)
  return command !== null && command === identity.command
}

export async function pidTerminalWithin(identity: ProcessIdentity, boundMs: number): Promise<boolean> {
  const deadline = Date.now() + boundMs
  for (;;) {
    if (!identityMatches(identity) || !pidAlive(identity.pid)) return true
    if (Date.now() >= deadline) return false
    await Bun.sleep(10)
  }
}

/** Polls a pid file written by a foreign helper and snapshots its command identity. */
export function readPidWhenWritten(path: string, boundMs: number, expectedCommand?: string): Promise<ProcessIdentity> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`helper pid never appeared at ${path}`)), boundMs)
    const directory = dirname(path)
    const filename = basename(path)
    const watcher = watch(directory, (_event, name) => {
      if (name !== filename) return
      void readIdentity().then((identity) => { if (identity !== null) finish(undefined, identity) }).catch(finish)
    })
    const finish = (error?: Error, identity?: ProcessIdentity): void => {
      clearTimeout(timer)
      watcher.close()
      if (error !== undefined) reject(error)
      else if (identity !== undefined) resolve(identity)
    }
    const readIdentity = async (): Promise<ProcessIdentity | null> => {
      const raw = Number((await readFile(path, "utf8")).trim())
      if (!Number.isInteger(raw) || raw <= 0) return null
      const command = commandForPid(raw)
      return command !== null && (expectedCommand === undefined || command.includes(expectedCommand)) ? { pid: raw, command } : null
    }
    void readIdentity().then((identity) => { if (identity !== null) finish(undefined, identity) }).catch((error: unknown) => {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) finish(error as Error)
    })
  })
}

/** Single identity read; null when absent or the process no longer matches. */
export async function readPidOnce(path: string, expectedCommand?: string): Promise<ProcessIdentity | null> {
  try {
    const raw = Number((await readFile(path, "utf8")).trim())
    if (!Number.isInteger(raw) || raw <= 0) return null
    const command = commandForPid(raw)
    return command !== null && (expectedCommand === undefined || command.includes(expectedCommand)) ? { pid: raw, command } : null
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
    return null
  }
}

/** SIGKILL only when the target still has the command identity captured at registration. */
export function killIfAlive(identity: ProcessIdentity): void {
  if (!identityMatches(identity)) return
  try {
    process.kill(identity.pid, "SIGKILL")
  } catch (error) {
    if (pidAlive(identity.pid)) throw error
  }
}
