// Process + daemon probes for task-host-e2e.mjs (todo 41): running the binary under test, reading the
// daemon's status JSON and the task store, scoping the process table to ONE sandbox, and the cleanup
// receipt every scenario ends with. A foreign session's daemon may be running on this machine, so every
// process query is filtered by this sandbox's own root path and never by a bare `--mode rpc` match.
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"

import { REAL_AGENT_DIRS, sandboxEnv } from "./task-host-e2e-sandbox.mjs"

export function runBin(sandbox, args, { timeoutMs = 120_000, env = {}, cwd = sandbox.cwd } = {}) {
  const result = spawnSync(sandbox.bin, args, { cwd, env: sandboxEnv(sandbox, env), encoding: "utf8", timeout: timeoutMs })
  return { status: result.status, signal: result.signal, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
}

export function lastJsonLine(text) {
  const lines = text.trim().split("\n").filter((line) => line.trim().length > 0)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index])
    } catch {
      // banner or prose line
    }
  }
  return undefined
}

export function daemonStatus(sandbox, { includeWorkers = false } = {}) {
  const args = ["daemon", "status", "--json", ...(includeWorkers ? ["--include-workers"] : [])]
  const result = runBin(sandbox, args, { timeoutMs: 60_000 })
  return { exitCode: result.status, json: lastJsonLine(result.stdout), stderr: result.stderr }
}

export function parentArgv(sandbox, mockEntry, prompt) {
  return ["-e", mockEntry, "-p", "--mode", "json", "--provider", "omo-mock", "--model", "mock-1", "--session-dir", sandbox.sessionDir, prompt]
}

export function spawnParent(sandbox, mockEntry, prompt, { env = {}, capture = false } = {}) {
  const child = spawn(sandbox.bin, parentArgv(sandbox, mockEntry, prompt), {
    cwd: sandbox.cwd,
    env: sandboxEnv(sandbox, env),
    detached: true,
    stdio: capture ? ["ignore", "pipe", "pipe"] : ["ignore", "ignore", "ignore"],
  })
  const chunks = { stdout: "", stderr: "" }
  if (capture) {
    child.stdout?.setEncoding("utf8")
    child.stderr?.setEncoding("utf8")
    child.stdout?.on("data", (chunk) => { chunks.stdout += chunk })
    child.stderr?.on("data", (chunk) => { chunks.stderr += chunk })
  }
  const closed = new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ status: code, signal }))
    child.once("error", () => resolve({ status: null, signal: null }))
  })
  return { child, chunks, closed }
}

export function readTaskRecords(sandbox) {
  const dir = join(sandbox.stateDir, "tasks")
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .flatMap((file) => {
      try {
        return [JSON.parse(readFileSync(join(dir, file), "utf8"))]
      } catch {
        return []
      }
    })
}

export function psSnapshot() {
  try {
    return execFileSync("ps", ["-axo", "pid=,args="], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const [, pid, args] = /^(\d+)\s+(.*)$/.exec(line) ?? []
        return pid === undefined ? undefined : { pid: Number(pid), args }
      })
      .filter((entry) => entry !== undefined)
  } catch {
    return []
  }
}

/** Every live process whose argv names THIS sandbox - never a foreign session's host on the same machine. */
export function sandboxProcesses(sandbox) {
  return psSnapshot().filter((entry) => entry.args.includes(sandbox.root) && !entry.args.includes("ps -axo"))
}

/**
 * E8: a daemon-hosted child is a SESSION, so no per-child `--mode rpc` process may exist. Three things
 * make this count trustworthy: the daemon's own internal host also runs `--mode rpc` but carries
 * `--multi-session`, so it is excluded; a per-child process names its session dir in the ENVIRONMENT
 * rather than its argv, so it is recognized by the pid the task store recorded for it or by this run's
 * private binary runtime under the sandbox HOME; and a foreign session's children, which run from
 * another HOME and are absent from this store, are never counted.
 */
export function perChildRpcProcesses(sandbox) {
  const owned = new Set(readTaskRecords(sandbox).filter((record) => typeof record.pid === "number").map((record) => record.pid))
  return psSnapshot().filter((entry) =>
    entry.args.includes("--mode rpc") &&
    !entry.args.includes("--multi-session") &&
    (owned.has(entry.pid) || entry.args.includes(sandbox.home) || entry.args.includes(sandbox.root)))
}

export function globalModeRpcCount() {
  return psSnapshot().filter((entry) => entry.args.includes("--mode rpc")).length
}

/**
 * The pid of the generation that currently owns the socket, read from the v2 daemon state the way the
 * plan's zombie check does: layout.json -> <dir>/host.pid -> generations/<instance>/host.pid -> .pid.
 * A flat legacy pidfile is deliberately NOT read: a v2 client must never mistake one for its own.
 */
export function generationHostPid(agentDir) {
  try {
    const root = join(agentDir, "rpc-host-daemon")
    const layout = JSON.parse(readFileSync(join(root, "layout.json"), "utf8"))
    const pointer = JSON.parse(readFileSync(join(root, layout.dir, "host.pid"), "utf8"))
    const generation = JSON.parse(readFileSync(join(root, layout.dir, pointer.generation_dir, "host.pid"), "utf8"))
    return typeof generation.pid === "number" ? generation.pid : undefined
  } catch {
    return undefined
  }
}

/** Zombies parented by THIS host pid - darwin `ps -axo`, linux `ps -eo`, same awk selection. */
export function zombieChildCount(hostPid) {
  const flag = process.platform === "darwin" ? "-axo" : "-eo"
  try {
    return execFileSync("ps", [flag, "ppid=,stat="], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .filter((parts) => Number(parts[0]) === hostPid && /^Z/.test(parts[1] ?? "")).length
  } catch {
    return undefined
  }
}

export function childPids(pid) {
  try {
    return execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" })
      .split(/\s+/)
      .map(Number)
      .filter((value) => Number.isInteger(value) && value > 0)
  } catch {
    return []
  }
}

export function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function waitFor(probe, { timeoutMs = 60_000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value) return value
    if (Date.now() >= deadline) return undefined
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

export function socketInode(socketPath) {
  try {
    return statSync(socketPath).ino
  } catch {
    return undefined
  }
}

/**
 * The cleanup receipt every scenario must record: the daemon this scenario started is stopped, its pid
 * is gone, no process anywhere still names this sandbox, and the sandbox directory is removed.
 */
export async function cleanupScenario(sandbox, { hostPids = [] } = {}) {
  // A daemon's internal `--mode rpc --multi-session` host is a CHILD of the supervisor and its argv
  // names the shared runtime rather than this sandbox, so it is collected through the pid tree.
  const owned = [...new Set(hostPids.flatMap((pid) => [pid, ...childPids(pid)]))]
  // Sampled while this scenario's daemon is still UP, because an argv is the only place a host can
  // reveal that it was pointed at the operator's real agent dir instead of the sandbox's.
  const live = sandboxProcesses(sandbox)
  const addressingReal = live.filter((entry) => REAL_AGENT_DIRS.some((dir) => entry.args.includes(dir)))
  const stopped = runBin(sandbox, ["daemon", "stop"], { timeoutMs: 60_000 })
  const survivors = sandboxProcesses(sandbox)
  for (const entry of survivors) {
    try {
      process.kill(entry.pid, "SIGTERM")
    } catch {
      // already gone
    }
  }
  const gone = await waitFor(() => sandboxProcesses(sandbox).length === 0, { timeoutMs: 20_000 })
  for (const entry of sandboxProcesses(sandbox)) {
    try {
      process.kill(entry.pid, "SIGKILL")
    } catch {
      // already gone
    }
  }
  for (const pid of owned.filter((candidate) => pidAlive(candidate))) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      // already gone
    }
  }
  const residual = sandboxProcesses(sandbox)
  const hostLog = daemonStderrTail(sandbox.agentDir)
  rmSync(sandbox.root, { recursive: true, force: true })
  return {
    scenario: sandbox.name,
    daemonStopExit: stopped.status,
    daemonStopSummary: stopped.stdout.trim().split("\n").pop() ?? "",
    ownedHostPids: owned,
    hostPidsStillAlive: owned.filter((pid) => pidAlive(pid)),
    liveSandboxProcessesBeforeStop: live.map((entry) => entry.pid),
    processesNamingRealAgentDir: addressingReal.map((entry) => ({ pid: entry.pid, args: entry.args.slice(0, 200) })),
    terminatedSurvivors: survivors.map((entry) => entry.pid),
    sandboxProcessCount: residual.length,
    forcedKill: gone === undefined,
    sandboxRemoved: !existsSync(sandbox.root),
    daemonStderrTail: hostLog,
  }
}

/** The host's own log, captured BEFORE the sandbox is removed - the transcript's only view inside it. */
function daemonStderrTail(agentDir, limit = 25) {
  const root = join(agentDir, "rpc-host-daemon")
  if (!existsSync(root)) return []
  return readdirSync(root)
    .flatMap((entry) => {
      const path = join(root, entry, "stderr.log")
      return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter((line) => line.trim().length > 0) : []
    })
    .slice(-limit)
}
