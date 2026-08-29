import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import type { ChildProcess, ChildProcessWithoutNullStreams } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { identityMatches, killIfAlive, type ProcessIdentity } from "./process-liveness.test-support"

const holdLockFixture = join(import.meta.dir, "__fixtures__", "hold-lock.ts")
const READY_TIMEOUT_MS = 10_000
const EXIT_TIMEOUT_MS = 5_000

type ExitInfo = { readonly code: number | null; readonly signal: NodeJS.Signals | null }

function exitWithin(child: ChildProcess, boundMs: number): Promise<ExitInfo> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`child ${String(child.pid)} did not exit within ${boundMs}ms`)), boundMs)
    child.once("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal }) })
  })
}

function waitForReady(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("lock holder never reported ready")), READY_TIMEOUT_MS)
    let output = ""
    const onData = (chunk: Buffer): void => {
      output += chunk.toString("utf8")
      if (!output.includes("held\n")) return
      clearTimeout(timer)
      child.stdout.off("data", onData)
      resolve()
    }
    child.stdout.on("data", onData)
    child.once("exit", () => reject(new Error("lock holder exited before readiness")))
  })
}

async function terminate(identity: ProcessIdentity | undefined, child: ChildProcess | undefined): Promise<void> {
  if (identity !== undefined && identityMatches(identity)) killIfAlive(identity)
  if (child !== undefined) {
    try { await exitWithin(child, EXIT_TIMEOUT_MS) } catch { child.kill("SIGKILL") }
  }
}

describe("hold-lock fixture lifecycle", () => {
  test("exits on the parent-owned stdin EOF event", async () => {
    const root = await mkdtemp(join(tmpdir(), "omo-hold-lock-lifecycle-"))
    const child = spawn(process.execPath, [holdLockFixture, join(root, "finalize.lock")], { stdio: ["pipe", "pipe", "pipe"] })
    try {
      await waitForReady(child)
      const exit = exitWithin(child, EXIT_TIMEOUT_MS)
      child.stdin.end()
      expect((await exit).signal).toBeNull()
    } finally {
      child.kill("SIGKILL")
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

  test("an abruptly killed wrapper closes the holder ownership channel", async () => {
    const root = await mkdtemp(join(tmpdir(), "omo-hold-lock-abrupt-"))
    const wrapperPath = join(root, "abrupt-wrapper.mjs")
    const control = createServer()
    const connections = new Set<Socket>()
    control.on("connection", (socket) => connections.add(socket))
    await new Promise<void>((resolve) => control.listen(0, "127.0.0.1", resolve))
    const address = control.address()
    if (address === null || typeof address === "string") throw new Error("control server did not bind")
    await writeFile(wrapperPath, `
import { spawn } from "node:child_process"
import { connect } from "node:net"
const child = spawn(process.execPath, [process.env.HOLDER_FIXTURE, process.env.LOCK_PATH], { stdio: ["pipe", "pipe", "ignore"] })
const control = connect({ host: "127.0.0.1", port: Number(process.env.CONTROL_PORT) })
child.stdout.on("data", (chunk) => { if (chunk.toString().includes("held\\n")) process.kill(process.pid, "SIGKILL") })
`, "utf8")
    const wrapper = spawn(process.execPath, [wrapperPath], {
      stdio: "ignore",
      env: { ...process.env, HOLDER_FIXTURE: holdLockFixture, LOCK_PATH: join(root, "facts-runs.lock"), CONTROL_PORT: String(address.port) },
    })
    try {
      const holderSocket = await new Promise<Socket>((resolve) => control.once("connection", resolve))
      await exitWithin(wrapper, EXIT_TIMEOUT_MS)
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("holder ownership channel stayed open")), EXIT_TIMEOUT_MS)
        holderSocket.once("close", () => { clearTimeout(timer); resolve() })
      })
      expect(holderSocket.destroyed).toBe(true)
    } finally {
      await terminate(undefined, wrapper)
      control.close()
      for (const socket of connections) socket.destroy()
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
})
