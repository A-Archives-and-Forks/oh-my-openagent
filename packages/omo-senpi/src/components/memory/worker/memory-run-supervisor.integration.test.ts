import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

// Each case drives a real supervisor, bootstrap, and model child - three spawned bun processes
// plus git work. The 5s default is a fast-machine assumption, not a budget those subprocesses
// fit on a loaded CI runner; the assertions stay event-driven with no sleeps.
const WAIT_MS = process.platform === "win32" ? 60_000 : 30_000
setDefaultTimeout(WAIT_MS)

const supervisorPath = join(import.meta.dir, "memory-run-supervisor.ts")
const childFixture = join(import.meta.dir, "__fixtures__", "supervisor-child.ts")
const parentFixture = join(import.meta.dir, "__fixtures__", "supervisor-parent.ts")
const roots: string[] = []
const processGroups = new Set<number>()

interface Outcome {
  readonly version: 1
  readonly runId: string
  readonly childExit: { readonly code: number | null; readonly signal: string | null }
  readonly timedOut: boolean
}

async function makeRun(options: {
  readonly mode: "inspect" | "graceful" | "stubborn"
  readonly hardDeadlineAt?: number
  readonly terminationGraceMs?: number
}): Promise<string> {
  const runDir = await mkdtemp(join(tmpdir(), "memory-run-supervisor-"))
  roots.push(runDir)
  await mkdir(runDir, { recursive: true, mode: 0o700 })
  await writeFile(join(runDir, "ledger.json"), `${JSON.stringify({ version: 1, runId: "run-a", kind: "reflection" })}\n`)
  await writeFile(join(runDir, "launch.json"), `${JSON.stringify({
    version: 1,
    runId: "run-a",
    kind: "reflection",
    command: process.execPath,
    args: [childFixture, options.mode, runDir],
    cwd: runDir,
    env: { ...process.env },
    hardDeadlineAt: options.hardDeadlineAt ?? Date.now() + 10_000,
    terminationGraceMs: options.terminationGraceMs ?? 1_000,
    maxOutputBytes: 65_536,
    stdoutPath: join(runDir, "child-stdout.log"),
    stderrPath: join(runDir, "child-stderr.log"),
  })}\n`, { mode: 0o600 })
  return runDir
}

function launchSupervisor(runDir: string): ChildProcess {
  const clockPath = join(runDir, "clock.txt")
  return spawn(process.execPath, [supervisorPath, runDir], {
    detached: true,
    stdio: "ignore",
    env: existsSync(clockPath) ? {
      ...process.env,
      OMO_MEMORY_SUPERVISOR_ALLOW_TEST_SEAMS: "1",
      OMO_MEMORY_SUPERVISOR_CLOCK_PATH: clockPath,
    } : process.env,
  })
}

async function advanceClock(runDir: string, value: number): Promise<void> {
  const path = join(runDir, "clock.txt")
  const temporary = `${path}.next`
  await writeFile(temporary, `${value}\n`, "utf8")
  await rename(temporary, path)
}

async function waitForPath(path: string, timeoutMs = 4_000): Promise<void> {
  if (existsSync(path)) return
  const { watch } = await import("node:fs")
  const directory = dirname(path)
  await new Promise<void>((resolve, reject) => {
    let settled = false
    // Re-check on any event in the directory: run artifacts are published by writing a temp file and
    // renaming over the target, and Linux inotify reports only the rename SOURCE name, so matching
    // the target's basename never fires there.
    const watcher = watch(directory, () => {
      if (existsSync(path)) finish()
    })
    // inotify delivery under bun on linux drops or delays events under load; the interval
    // re-check backs the watcher and existsSync stays the authority.
    const interval = setInterval(() => {
      if (existsSync(path)) finish()
    }, 50)
    const timeout = setTimeout(() => finish(new Error(`waited ${timeoutMs}ms for ${path}`)), timeoutMs)
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      clearInterval(interval)
      watcher.close()
      error === undefined ? resolve() : reject(error)
    }
    if (existsSync(path)) finish()
  })
}

async function waitForLedgerChild(runDir: string): Promise<{ readonly childPid: number }> {
  const path = join(runDir, "ledger.json")
  const read = async (): Promise<{ readonly childPid: number } | undefined> => {
    const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
    return typeof value.childPid === "number" ? { childPid: value.childPid } : undefined
  }
  const initial = await read()
  if (initial !== undefined) return initial
  const { watch } = await import("node:fs")
  return await new Promise((resolve, reject) => {
    let settled = false
    // Re-read on any event in the directory: updateRunLedger writes via temp+rename, and Linux
    // inotify reports only the rename SOURCE name, so filtering on "ledger.json" never fires there.
    const probe = async (): Promise<void> => {
      const value = await read().catch(() => undefined)
      if (value !== undefined) finish(value)
    }
    const watcher = watch(runDir, () => void probe())
    // Same inotify delivery caveat: the interval re-read backs the watcher; the content
    // predicate (childPid is a number) stays the authority.
    const interval = setInterval(() => void probe(), 50)
    const timeout = setTimeout(() => finish(undefined, new Error(`waited ${WAIT_MS}ms for child identity`)), WAIT_MS)
    const finish = (value?: { readonly childPid: number }, error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      clearInterval(interval)
      watcher.close()
      error === undefined && value !== undefined ? resolve(value) : reject(error ?? new Error("missing child identity"))
    }
    void read().then((value) => {
      if (value !== undefined) finish(value)
    }, (error: unknown) => finish(undefined, error instanceof Error ? error : new Error(String(error))))
  })
}

async function readOutcome(runDir: string): Promise<Outcome> {
  await waitForPath(join(runDir, "outcome.json"))
  return JSON.parse(await readFile(join(runDir, "outcome.json"), "utf8")) as Outcome
}

async function waitForExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`waited ${WAIT_MS}ms for process exit`)), WAIT_MS)
    child.once("error", reject)
    child.once("close", (code, signal) => {
      clearTimeout(timeout)
      resolve({ code, signal })
    })
  })
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  process.kill(process.platform === "win32" ? pid : -pid, signal)
}

function groupIsAlive(pid: number): boolean {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, 0)
    return true
  } catch {
    return false
  }
}

afterEach(async () => {
  for (const pid of processGroups) {
    try {
      signalGroup(pid, "SIGKILL")
    } catch {
      continue
    }
  }
  processGroups.clear()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("memory run supervisor", () => {
  test("#given a fixture launch manifest #when supervised #then identity is durable before the command starts and the outcome is published once", async () => {
    // given
    const runDir = await makeRun({ mode: "inspect" })

    // when
    const supervisor = launchSupervisor(runDir)
    const exit = waitForExit(supervisor)
    const outcome = await readOutcome(runDir)
    await exit

    // then
    const observation = JSON.parse(await readFile(join(runDir, "child-observation.json"), "utf8")) as Record<string, unknown>
    expect(observation.pid).toBe(supervisor.pid)
    expect(typeof observation.processStart === "string" || observation.processStart === null).toBe(true)
    expect(typeof observation.childPid).toBe("number")
    expect(typeof observation.childProcessStart === "string" || observation.childProcessStart === null).toBe(true)
    expect(outcome).toMatchObject({ version: 1, runId: "run-a", childExit: { code: 23, signal: null }, timedOut: false })
    expect(existsSync(join(runDir, "launch.json"))).toBe(false)
    expect((await readdir(runDir)).filter((name) => name === "outcome.json")).toEqual(["outcome.json"])
  })

  test("#given a detached supervisor launched by a parent #when the parent is killed #then the supervisor still publishes the child outcome", async () => {
    // given
    const runDir = await makeRun({ mode: "inspect" })
    const parent = spawn(process.execPath, [parentFixture, supervisorPath, runDir], { stdio: ["pipe", "pipe", "inherit"] })
    const parentExit = waitForExit(parent)
    const ready = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`waited ${WAIT_MS}ms for parent launch receipt`)), WAIT_MS)
      parent.stdout?.once("data", (chunk) => {
        clearTimeout(timeout)
        resolve(String(chunk))
      })
    })
    expect(JSON.parse(ready)).toHaveProperty("supervisorPid")

    // when
    parent.kill("SIGKILL")
    await parentExit
    const outcome = await readOutcome(runDir)

    // then
    expect(outcome.childExit).toEqual({ code: 23, signal: null })
  })

  test("#given a bootstrap waiting for release #when its parent pipe closes #then it exits without starting the manifest command", async () => {
    // given
    const runDir = await makeRun({ mode: "inspect" })
    const bootstrap = spawn(process.execPath, [supervisorPath, "--child-bootstrap", runDir], {
      detached: true,
      stdio: ["pipe", "ignore", "ignore", "ignore"],
    })
    const exit = waitForExit(bootstrap)

    // when
    bootstrap.stdin?.end()
    const result = await exit

    // then
    expect(result).toEqual({ code: 0, signal: null })
    expect(existsSync(join(runDir, "child-observation.json"))).toBe(false)
    expect(existsSync(join(runDir, "child-started.json"))).toBe(false)
  })

  test("#given a released child #when the supervisor is killed abruptly #then the recorded live process group can be terminated", async () => {
    // given
    const runDir = await makeRun({ mode: "graceful" })
    const supervisor = launchSupervisor(runDir)
    const supervisorExit = waitForExit(supervisor)
    const { childPid } = await waitForLedgerChild(runDir)
    processGroups.add(childPid)
    await waitForPath(join(runDir, "child-started.json"))

    // when
    supervisor.kill("SIGKILL")
    await supervisorExit
    expect(groupIsAlive(childPid)).toBe(true)
    signalGroup(childPid, "SIGTERM")
    await waitForPath(join(runDir, "child-terminated.json"))

    // then
    expect(existsSync(join(runDir, "outcome.json"))).toBe(false)
    expect(JSON.parse(await readFile(join(runDir, "ledger.json"), "utf8"))).toMatchObject({ childPid })
  })

  test("#given a child that exits during termination grace #when the absolute deadline arrives #then timeout is recorded without escalation", async () => {
    // given
    const runDir = await makeRun({ mode: "graceful", hardDeadlineAt: 2_000, terminationGraceMs: 2_000 })
    await writeFile(join(runDir, "clock.txt"), "1000\n", "utf8")

    // when
    const supervisor = launchSupervisor(runDir)
    const exit = waitForExit(supervisor)
    await waitForPath(join(runDir, "child-started.json"))
    await advanceClock(runDir, 2_000)
    if (process.platform === "win32") await advanceClock(runDir, 4_000)
    const outcome = await readOutcome(runDir)
    await exit

    // then
    expect(outcome.timedOut).toBe(true)
    if (process.platform !== "win32") {
      expect(outcome.childExit).toEqual({ code: 0, signal: null })
      expect(existsSync(join(runDir, "child-terminated.json"))).toBe(true)
    }
  })

  test("#given a child that ignores SIGTERM #when termination grace expires #then the process group is killed", async () => {
    // given
    const runDir = await makeRun({ mode: "stubborn", hardDeadlineAt: 2_000, terminationGraceMs: 100 })
    await writeFile(join(runDir, "clock.txt"), "1000\n", "utf8")

    // when
    const supervisor = launchSupervisor(runDir)
    const exit = waitForExit(supervisor)
    await waitForPath(join(runDir, "child-started.json"))
    await advanceClock(runDir, 2_000)
    if (process.platform !== "win32") await waitForPath(join(runDir, "child-terminated.json"))
    await advanceClock(runDir, 2_100)
    const outcome = await readOutcome(runDir)
    await exit

    // then
    expect(outcome.timedOut).toBe(true)
    if (process.platform !== "win32") {
      expect(outcome.childExit).toEqual({ code: null, signal: "SIGKILL" })
      expect(existsSync(join(runDir, "child-terminated.json"))).toBe(true)
    }
  })
})
