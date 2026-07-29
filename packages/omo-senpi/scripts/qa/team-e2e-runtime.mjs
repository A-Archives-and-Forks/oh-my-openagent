import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"

export function resolveSenpiInvocation(senpiBin, operations = {}) {
  const platform = operations.platform ?? process.platform
  if (platform === "win32") {
    const launcherName = basename(senpiBin).toLowerCase()
    if (launcherName.endsWith(".exe") || (launcherName !== "senpi" && launcherName !== "senpi.cmd")) {
      return { command: senpiBin, prefixArgs: [] }
    }
    const cliPath = join(dirname(senpiBin), "node_modules", "@code-yeongyu", "senpi", "dist", "cli.js")
    const fileExists = operations.existsSync ?? existsSync
    if (fileExists(cliPath)) {
      return {
        command: operations.execPath ?? process.execPath,
        prefixArgs: [cliPath],
      }
    }
  }
  return { command: senpiBin, prefixArgs: [] }
}

export function startSenpiRun(input) {
  writeFileSync(join(input.sandbox.cwd, "mock-script.json"), `${JSON.stringify(input.script, null, 2)}\n`)
  const sessionDir = join(input.sandbox.root, "sessions")
  mkdirSync(sessionDir, { recursive: true })
  const args = [
    "-e",
    input.mockProviderEntry,
    "-p",
    "--mode",
    "json",
    "--provider",
    "omo-mock",
    "--model",
    "mock-1",
    "--session-dir",
    sessionDir,
    input.prompt,
  ]
  const invocation = resolveSenpiInvocation(input.senpiBin)
  const child = spawn(invocation.command, [...invocation.prefixArgs, ...args], {
    cwd: input.sandbox.cwd,
    env: {
      ...process.env,
      SENPI_CODING_AGENT_DIR: input.sandbox.agentDir,
      XDG_CONFIG_HOME: input.sandbox.xdgConfigHome,
      SENPI_CODING_AGENT_SESSION_DIR: sessionDir,
      OMO_SENPI_QA: "1",
      ...(input.obsDir === undefined ? {} : { OMO_TEAM_E2E_OBS: input.obsDir }),
      ...(input.extraEnv ?? {}),
    },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  })
  if (typeof child.pid === "number") input.onPid?.(child.pid)

  let stdout = ""
  let stderr = ""
  let settled = false
  let finishRun = () => undefined
  const completion = new Promise((resolveRun) => { finishRun = resolveRun })
  const finish = (status, extraStderr) => {
    if (settled) return
    settled = true
    clearTimeout(hardTimer)
    finishRun({
      status,
      stdout,
      stderr: extraStderr === undefined ? stderr : `${stderr}\n${extraStderr}`,
      events: input.parseEvents(stdout),
    })
  }
  const hardTimer = setTimeout(() => {
    if (typeof child.pid === "number") killProcessGroup(child.pid)
    finish(null, "team e2e run exceeded 120000ms")
  }, 120_000)
  child.stdout.on("data", (chunk) => { stdout += chunk })
  child.stderr.on("data", (chunk) => { stderr += chunk })
  child.on("close", (status) => finish(status))
  child.on("error", (error) => finish(null, error.message))

  return {
    pid: child.pid,
    completion,
    kill: () => {
      if (typeof child.pid === "number") killProcessGroup(child.pid)
    },
  }
}

export async function pollUntil(readValue, accepted, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let value = await readValue()
  while (!accepted(value) && Date.now() < deadline) {
    await delay(Math.min(50, Math.max(1, deadline - Date.now())))
    value = await readValue()
  }
  return value
}

export function killProcess(pid) {
  try {
    process.kill(pid, "SIGKILL")
    return true
  } catch (error) {
    if (isMissingProcess(error)) return false
    throw error
  }
}

/**
 * Terminate exactly one QA-owned process tree and return evidence that distinguishes a successful
 * termination, a root that had already exited, and a failed termination. Windows has no POSIX
 * negative-pid process-group signal, so use taskkill's exact /PID + /T tree contract there.
 */
export function terminateProcessTree(pid, operations = {}) {
  const platform = operations.platform ?? process.platform
  const isProcessAlive = operations.isProcessAlive ?? defaultIsProcessAlive
  if (!isProcessAlive(pid)) return { kind: "already-exited", pid, platform }

  if (platform === "win32") {
    const run = operations.spawnSync ?? spawnSync
    const result = run("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { encoding: "utf8" })
    const aliveAfter = isProcessAlive(pid)
    if (!aliveAfter) {
      return result.status === 0
        ? { kind: "terminated", pid, platform }
        : { kind: "already-exited", pid, platform }
    }
    return {
      kind: "failed",
      pid,
      platform,
      status: result.status ?? null,
      error: processTreeError(result),
    }
  }

  const signal = operations.processKill ?? process.kill.bind(process)
  try {
    signal(-pid, "SIGKILL")
  } catch (error) {
    if (isMissingProcess(error)) return { kind: "already-exited", pid, platform }
    return { kind: "failed", pid, platform, status: null, error: error instanceof Error ? error.message : String(error) }
  }
  return isProcessAlive(pid)
    ? { kind: "failed", pid, platform, status: null, error: "process group remained alive after SIGKILL" }
    : { kind: "terminated", pid, platform }
}

export function killProcessGroup(pid, operations = {}) {
  const terminate = operations.terminateProcessTree
    ?? ((targetPid) => terminateProcessTree(targetPid, operations))
  return terminate(pid).kind !== "failed"
}

export function cleanupProcessGroups(groupIds, operations = {}) {
  const platform = operations.platform ?? process.platform
  if (platform === "win32") {
    const terminate = operations.terminateProcessTree
      ?? ((targetPid) => terminateProcessTree(targetPid, operations))
    let leaked = 0
    for (const groupId of groupIds) {
      if (terminate(groupId)?.kind === "failed") leaked += 1
    }
    return leaked
  }

  const listGroupPids = operations.listGroupPids ?? readProcessGroupPids
  const kill = operations.killProcess ?? killProcess
  let leaked = 0
  for (const groupId of groupIds) {
    const members = listGroupPids(groupId).filter((pid) => pid !== process.pid)
    for (const pid of members) kill(pid)
    leaked += listGroupPids(groupId).filter((pid) => pid !== process.pid).length
  }
  return leaked
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function defaultIsProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (isMissingProcess(error)) return false
    if (error instanceof Error && "code" in error && error.code === "EPERM") return true
    throw error
  }
}

function processTreeError(result) {
  if (result.error instanceof Error) return result.error.message
  const stderr = typeof result.stderr === "string" ? result.stderr.trim() : ""
  return stderr || `taskkill exited with status ${result.status ?? "unknown"}`
}

function isMissingProcess(error) {
  return error instanceof Error && "code" in error && error.code === "ESRCH"
}

function readProcessGroupPids(groupId) {
  const probe = spawnSync("pgrep", ["-g", String(groupId)], { encoding: "utf8" })
  return (probe.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0)
}
