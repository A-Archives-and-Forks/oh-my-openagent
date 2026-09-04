import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, readdir, readFile } from "node:fs"
import { join } from "node:path"
import type { CreateAgentSessionOptions, ToolDefinition } from "@code-yeongyu/senpi"
import type { CreateChildSession } from "@oh-my-opencode/senpi-task"
import { PendingNudges } from "@oh-my-opencode/memory-core"
import type { ChildHandle } from "@oh-my-opencode/senpi-task"
import { MemorianGateRunner } from "./memorian-runner"
import { CANDIDATE_PATH, fixture, launchInput, nudgeOnce, registrySnapshot, roots, runnerOptions, scriptedSession, SESSION_ID } from "./memorian-runner.test-support"
import { rmEfaultTolerant } from "./teardown.test-support"

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rmEfaultTolerant(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }))) })

describe("MemorianGateRunner", () => {
  test("#given child setup never resolves #when the whole-launch deadline fires #then the latch releases and a late handle is disposed", async () => {
    // given
    const { identityPaths } = await fixture()
    let resolveStart: ((handle: ChildHandle) => void) | undefined
    let disposed = 0
    const lateHandle: ChildHandle = {
      task_id: "late",
      sessionId: "late",
      steer: async () => undefined,
      followUp: async () => undefined,
      abort: async () => undefined,
      subscribe: () => () => undefined,
      waitForIdle: async () => ({ status: "cancelled" }),
      lastAssistantText: () => undefined,
      dispose: () => { disposed += 1 },
    }
    const runner = new MemorianGateRunner(runnerOptions(identityPaths, {
      deadlineMs: 5,
      createRunner: () => ({ start: async () => new Promise<ChildHandle>((resolve) => { resolveStart = resolve }) }),
    }))

    // when
    const result = await runner.launch(launchInput())
    resolveStart?.(lateHandle)
    await Promise.resolve()

    // then
    expect(result).toMatchObject({ status: "failed", cause: "deadline" })
    expect((await runner.launch(launchInput())).status).not.toBe("active")
    expect(disposed).toBe(1)
  })

  test("#given a child that never settles #when the deadline fires #then the child is aborted and disposed", async () => {
    // given
    const { identityPaths } = await fixture()
    let resolveIdle: (() => void) | undefined
    let resolveAbort: (() => void) | undefined
    let resolveDispose: (() => void) | undefined
    const aborted = new Promise<void>((resolve) => { resolveAbort = resolve })
    const disposed = new Promise<void>((resolve) => { resolveDispose = resolve })
    const handle: ChildHandle = {
      task_id: "hung",
      sessionId: "hung",
      steer: async () => undefined,
      followUp: async () => undefined,
      abort: async () => { resolveAbort?.(); resolveIdle?.() },
      subscribe: () => () => undefined,
      waitForIdle: () => new Promise((resolve) => { resolveIdle = () => resolve({ status: "cancelled" }) }),
      lastAssistantText: () => undefined,
      dispose: () => { resolveDispose?.() },
    }
    const runner = new MemorianGateRunner(runnerOptions(identityPaths, {
      createRunner: () => ({ start: async () => handle }),
      deadlineMs: 20,
    }))

    // when
    const result = await runner.launch(launchInput())
    await Promise.all([aborted, disposed])

    // then
    expect(result).toMatchObject({ status: "failed", cause: "deadline" })
  })

  test("#given a completed child blocked on persistence #when cancel is called #then the pending payload is retracted", async () => {
    // given
    const { identityPaths } = await fixture()
    const child = scriptedSession(async (options) => { await nudgeOnce(options) })
    let releaseWrite: (() => void) | undefined
    let resolveWriteEntered: (() => void) | undefined
    const writeEntered = new Promise<void>((resolve) => { resolveWriteEntered = resolve })
    const pendingNudges = {
      write: async () => {
        resolveWriteEntered?.()
        await new Promise<void>((resolve) => { releaseWrite = resolve })
      },
      delete: async () => { releaseWrite?.() },
    }
    const runner = new MemorianGateRunner(runnerOptions(identityPaths, {
      createSession: child.createSession,
      pendingNudges,
      deadlineMs: 1000,
    }))

    // when
    const launch = runner.launch(launchInput())
    await child.whenPrompted()
    child.resolve()
    await writeEntered
    const cancelling = runner.cancel()
    releaseWrite?.()
    await cancelling
    const result = await launch

    // then
    expect(result).toMatchObject({ status: "dropped", cause: "cancelled" })
  })

  test("#given a child in flight #when cancel is called #then it aborts and disposes without writing a late nudge", async () => {
    // given
    const { identityPaths } = await fixture()
    let release: (() => void) | undefined
    let aborted = 0
    let disposed = 0
    const handle: ChildHandle = {
      task_id: "cancelled",
      sessionId: "cancelled",
      steer: async () => undefined,
      followUp: async () => undefined,
      abort: async () => { aborted += 1; release?.() },
      subscribe: () => () => undefined,
      waitForIdle: () => new Promise((resolve) => { release = () => resolve({ status: "cancelled" }) }),
      lastAssistantText: () => undefined,
      dispose: () => { disposed += 1 },
    }
    const runner = new MemorianGateRunner(runnerOptions(identityPaths, {
      createRunner: () => ({ start: async () => handle }),
      deadlineMs: 1000,
    }))

    // when
    const pending = runner.launch(launchInput())
    await Promise.resolve()
    await runner.cancel()
    const result = await pending

    // then
    expect(result).toMatchObject({ status: "failed" })
    expect(aborted).toBe(1)
    expect(disposed).toBe(1)
    expect(await new PendingNudges(identityPaths.recallPending).take(SESSION_ID, { currentEpoch: 0 })).toEqual([])
  })

})
