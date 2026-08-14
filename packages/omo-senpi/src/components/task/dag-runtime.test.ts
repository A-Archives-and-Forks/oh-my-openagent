import { afterEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { loadOmoConfig } from "@oh-my-opencode/omo-config-core"
import {
  type ManagedChildHandle,
  type ManagedRunner,
  type ManagedStartSpec,
  type RunnerOutcome,
} from "@oh-my-opencode/senpi-task"

import type { DagRunId } from "@oh-my-opencode/senpi-task/dag"

import { IdleInjectionCoordinator } from "../../extension/idle-injection-coordinator"
import { FakeExtensionAPI } from "../../../test-support/fake-extension-api"
import { createDagRuntime } from "./dag-runtime"
import { runDagTool } from "./dag-tool"
import { composeTaskEngine, type TaskRunnerFactories } from "./engine"
import type { CapturedUi } from "./runtime-context"

const cleanupRoots: string[] = []

afterEach(() => {
  for (const root of cleanupRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function deferred<T>() {
  let resolve = (_value: T): void => undefined
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

class ScriptedRunner implements ManagedRunner {
  readonly handles: Array<{ readonly spec: ManagedStartSpec; readonly settle: (output: string) => void }> = []
  readonly #signals = new Map<number, ReturnType<typeof deferred<void>>>()

  start(spec: ManagedStartSpec): Promise<ManagedChildHandle> {
    const outcome = deferred<RunnerOutcome>()
    const handle: ManagedChildHandle = {
      task_id: spec.taskId,
      sessionId: `child-${spec.taskId}`,
      pid: undefined,
      steer: () => Promise.resolve(),
      followUp: () => Promise.resolve(),
      abort: () => {
        outcome.resolve({ status: "cancelled" })
        return Promise.resolve()
      },
      subscribe: () => () => undefined,
      waitForOutcome: () => outcome.promise,
      lastAssistantText: () => undefined,
      dispose: () => Promise.resolve(),
    }
    this.handles.push({ spec, settle: (output) => outcome.resolve({ status: "completed", finalResponse: output }) })
    this.#signals.get(this.handles.length)?.resolve()
    return Promise.resolve(handle)
  }

  whenStarted(count: number): Promise<void> {
    if (this.handles.length >= count) return Promise.resolve()
    const signal = this.#signals.get(count) ?? deferred<void>()
    this.#signals.set(count, signal)
    return signal.promise
  }
}

class ManualTimers {
  readonly #timers = new Map<number, { readonly callback: () => void; readonly ms: number }>()
  #next = 0

  set(callback: () => void, ms: number): number {
    this.#next += 1
    this.#timers.set(this.#next, { callback, ms })
    return this.#next
  }

  clear(handle: ReturnType<typeof setTimeout> | number): void {
    if (typeof handle === "number") this.#timers.delete(handle)
  }

  flush(ms: number): void {
    const selected = [...this.#timers].filter(([, timer]) => timer.ms === ms)
    for (const [handle, timer] of selected) {
      this.#timers.delete(handle)
      timer.callback()
    }
  }
}

function fakeUi(widgetRows: string[][]): CapturedUi {
  return {
    notify: () => undefined,
    setStatus: () => undefined,
    setWidget: (key, rows) => {
      if (key === "omo-dag" && rows !== undefined) widgetRows.push(rows)
    },
    select: async () => undefined,
    confirm: async () => false,
  }
}

describe("assembled DAG runtime", () => {
  test("#given a live task component runtime #when a two-node dag runs #then scheduler, artifacts, rpc, widget, and one wake all observe the same run", async () => {
    // given
    const cwd = fs.mkdtempSync(join(tmpdir(), "omo-senpi-dag-runtime-"))
    cleanupRoots.push(cwd)
    const runner = new ScriptedRunner()
    const runnerFactories: TaskRunnerFactories = {
      inProcess: () => runner,
      process: () => runner,
    }
    const rpcEvents: Array<{ readonly name: string; readonly data: unknown }> = []
    const rpcHandlers = new Map<string, (data: unknown) => unknown | Promise<unknown>>()
    const pi = Object.assign(new FakeExtensionAPI(), {
      rpc: {
        emit: (name: string, data: unknown) => rpcEvents.push({ name, data }),
        handle: (name: string, handler: (data: unknown) => unknown | Promise<unknown>) => rpcHandlers.set(name, handler),
      },
    })
    const wakeDeliveries: string[] = []
    const coordinator = new IdleInjectionCoordinator((message) => { wakeDeliveries.push(message.content) })
    const engine = composeTaskEngine({
      pi,
      omoConfig: loadOmoConfig({ cwd }).config,
      cwd,
      sharedParentTools: () => [],
      runnerFactories,
      coordinator,
    })
    const widgetRows: string[][] = []
    engine.runtime.captureFrom({
      mode: "tui",
      ui: fakeUi(widgetRows),
      sessionManager: { getSessionId: () => "session-dag" },
    })
    const bridgeTimers = new ManualTimers()
    const statusUiTimers = new ManualTimers()
    const logger = { info: () => undefined, warn: () => undefined, error: () => undefined }
    const runtime = createDagRuntime({ pi, engine, logger, coordinator, bridgeTimers, statusUiTimers })
    runtime.attach()

    // when
    const started = await runDagTool(
      {
        manager: runtime.manager,
        parentSessionId: () => "session-dag",
        rootSessionId: () => "session-dag",
        wait: runtime.wait,
        cancel: runtime.cancel,
      },
      {
        action: "start",
        definition: {
          key: "assembled-two-node",
          name: "assembled two node",
          nodes: [
            { id: "plan", prompt: "plan", subagent_type: "explore", model: "omo-mock/mock-1" },
            { id: "build", prompt: "build", subagent_type: "explore", model: "omo-mock/mock-1", dependsOn: ["plan"] },
          ],
        },
      },
    )
    if (started.details.kind !== "started") throw new Error("expected dag start")
    const runId = started.details.run_id as DagRunId
    await runner.whenStarted(1)
    bridgeTimers.flush(50)
    statusUiTimers.flush(250)
    runner.handles[0]?.settle("plan output")
    await runner.whenStarted(2)
    runner.handles[1]?.settle("build output")
    const result = await runtime.wait(runId, "session-dag")
    bridgeTimers.flush(50)
    await Promise.resolve()

    // then
    expect(result.status).toBe("completed")
    expect(result.nodes.plan).toEqual(expect.objectContaining({ state: "completed", output: "plan output" }))
    expect(result.nodes.build).toEqual(expect.objectContaining({ state: "completed", output: "build output" }))
    expect(fs.readFileSync(join(engine.stateDir, "dag", "results", runId, "plan.txt"), "utf8")).toBe("plan output")
    expect(fs.readFileSync(join(engine.stateDir, "dag", "results", runId, "build.txt"), "utf8")).toBe("build output")
    const persisted = runtime.manager.record(runId, "session-dag") as unknown as {
      readonly nodes: readonly { readonly id: string; readonly resultArtifact?: { readonly sha256: string; readonly bytes: number } }[]
    }
    expect(persisted.nodes.every((node) => node.resultArtifact !== undefined)).toBe(true)
    expect(rpcEvents.some((event) => event.name === "omo.dag.event")).toBe(true)
    expect(rpcEvents.some((event) => event.name === "omo.dag.updated")).toBe(true)
    expect(widgetRows.some((rows) => rows.some((row) => row.includes("assembled two node")))).toBe(true)
    expect(wakeDeliveries).toHaveLength(1)
    expect(wakeDeliveries[0]).toContain("DAG \"assembled two node\" completed")
    expect(rpcHandlers.has("omo.dag.snapshot")).toBe(true)

    const cancellable = await runDagTool(
      {
        manager: runtime.manager,
        parentSessionId: () => "session-dag",
        rootSessionId: () => "session-dag",
        wait: runtime.wait,
        cancel: runtime.cancel,
      },
      {
        action: "start",
        definition: {
          key: "assembled-cancel",
          name: "assembled cancel",
          nodes: [
            { id: "hold", prompt: "hold", subagent_type: "explore", model: "omo-mock/mock-1" },
            { id: "never", prompt: "never", subagent_type: "explore", model: "omo-mock/mock-1", dependsOn: ["hold"] },
          ],
        },
      },
    )
    if (cancellable.details.kind !== "started") throw new Error("expected cancellable dag start")
    await runner.whenStarted(3)
    const cancelled = await runDagTool(
      {
        manager: runtime.manager,
        parentSessionId: () => "session-dag",
        rootSessionId: () => "session-dag",
        wait: runtime.wait,
        cancel: runtime.cancel,
      },
      { action: "cancel", run_id: cancellable.details.run_id, reason: "stop proof" },
    )
    if (cancelled.details.kind !== "cancelled") throw new Error("expected dag cancellation")
    expect(cancelled.details.snapshot.status).toBe("cancelled")
    expect(runner.handles).toHaveLength(3)

    const resultsDir = join(engine.stateDir, "dag", "results")
    fs.chmodSync(resultsDir, 0o500)
    const copyFailure = await runDagTool(
      {
        manager: runtime.manager,
        parentSessionId: () => "session-dag",
        rootSessionId: () => "session-dag",
        wait: runtime.wait,
        cancel: runtime.cancel,
      },
      {
        action: "start",
        definition: {
          key: "assembled-copy-failure",
          name: "assembled copy failure",
          nodes: [{ id: "copy", prompt: "copy", subagent_type: "explore", model: "omo-mock/mock-1" }],
        },
      },
    )
    if (copyFailure.details.kind !== "started") throw new Error("expected copy-failure dag start")
    await runner.whenStarted(4)
    runner.handles[3]?.settle("unwritable output")
    await runtime.wait(copyFailure.details.run_id as DagRunId, "session-dag")
    fs.chmodSync(resultsDir, 0o755)
    const failedCopyRecord = runtime.manager.record(copyFailure.details.run_id as DagRunId, "session-dag") as unknown as {
      readonly diagnostics: readonly { readonly kind: string }[]
    }
    expect(failedCopyRecord.diagnostics.some((diagnostic) => diagnostic.kind === "journal_corrupt")).toBe(true)
  })
})
