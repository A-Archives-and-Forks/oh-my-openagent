import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import * as fs from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { loadOmoConfig, OmoTaskSettingsSchema } from "@oh-my-opencode/omo-config-core"
import {
  type ManagedChildHandle,
  type ManagedRunner,
  type ManagedStartSpec,
  type RunnerOutcome,
} from "@oh-my-opencode/senpi-task"
import * as dagEngine from "@oh-my-opencode/senpi-task/dag"

import { FakeExtensionAPI } from "../../../test-support/fake-extension-api"
import { composeTaskEngine } from "./engine"

const cleanupRoots: string[] = []

function deferred<T>() {
  let resolve = (_value: T): void => undefined
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function within<T>(promise: Promise<T>, label: string, ms = 300): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    void promise.then(
      (value) => {
        clearTimeout(timeout)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timeout)
        reject(error)
      },
    )
  })
}

class ControlledRunner implements ManagedRunner {
  readonly started = deferred<void>()
  readonly outcome = deferred<RunnerOutcome>()

  start(spec: ManagedStartSpec): Promise<ManagedChildHandle> {
    this.started.resolve()
    return Promise.resolve({
      task_id: spec.taskId,
      sessionId: `child-${spec.taskId}`,
      pid: undefined,
      steer: () => Promise.resolve(),
      followUp: () => Promise.resolve(),
      abort: () => Promise.resolve(),
      subscribe: () => () => undefined,
      waitForOutcome: () => this.outcome.promise,
      lastAssistantText: () => undefined,
      dispose: () => Promise.resolve(),
    })
  }
}

afterEach(() => {
  mock.restore()
  for (const root of cleanupRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe("assembled DAG runtime configuration", () => {
  test("#given subscriber_ring is one #when an assembled scheduler listener falls behind #then the configured overflow is durable", async () => {
    // given
    const cwd = fs.mkdtempSync(join(tmpdir(), "omo-senpi-dag-ring-"))
    cleanupRoots.push(cwd)
    const releaseFirst = deferred<void>()
    const firstDelivered = deferred<void>()
    const overflowDelivered = deferred<Extract<dagEngine.DagRunEvent, { type: "dag.stream.overflow" }>>()
    const createScheduler = dagEngine.createDagScheduler
    spyOn(dagEngine, "createDagScheduler").mockImplementation((options) => {
      const scheduler = createScheduler(options)
      let first = true
      scheduler.subscribe(async (event) => {
        if (event.type === "dag.stream.overflow") overflowDelivered.resolve(event)
        if (!first) return
        first = false
        firstDelivered.resolve()
        await releaseFirst.promise
      })
      return scheduler
    })
    const { createDagRuntime } = await import("./dag-runtime")
    const runner = new ControlledRunner()
    const pi = new FakeExtensionAPI()
    const baseConfig = loadOmoConfig({ cwd }).config
    const engine = composeTaskEngine({
      pi,
      omoConfig: {
        ...baseConfig,
        task: OmoTaskSettingsSchema.parse({ dag: { subscriber_ring: 1 } }),
      },
      cwd,
      sharedParentTools: () => [],
      runnerFactories: { inProcess: () => runner, process: () => runner },
    })
    const sessionId = "session-configured-ring"
    engine.runtime.captureFrom({ sessionManager: { getSessionId: () => sessionId } })
    const runtime = createDagRuntime({
      pi,
      engine,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    })
    await runtime.attach()

    // when
    const started = await runtime.manager.start({
      parentSessionId: sessionId,
      rootSessionId: sessionId,
      definition: {
        key: "configured-ring",
        name: "configured ring",
        nodes: [{ id: "overflow", prompt: "overflow", subagent_type: "explore", model: "omo-mock/mock-1" }],
      },
    })
    await within(firstDelivered.promise, "first scheduler event")
    await within(runner.started.promise, "node start")
    runner.outcome.resolve({ status: "completed", finalResponse: "done" })
    await within(runtime.wait(started.snapshot.runId, sessionId), "run completion")
    releaseFirst.resolve()
    const overflow = await within(overflowDelivered.promise, "configured subscriber overflow")

    // then
    expect(overflow.droppedCount).toBeGreaterThan(0)
    expect(overflow.recoverAfterSeq).toBe(started.snapshot.lastSeq)
    expect(dagEngine.createDagFileStore({ project_dir: cwd }).readEvents(
      started.snapshot.runId,
      0,
      { limit: 100 },
    ).events).toContainEqual(overflow)
    runtime.dispose()
  })
})
