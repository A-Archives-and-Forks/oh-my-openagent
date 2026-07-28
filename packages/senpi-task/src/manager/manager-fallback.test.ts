import { afterEach, describe, expect, test } from "bun:test"

import type { ManagedChildHandle } from "./child-handle"
import {
  FakeRunner,
  baseSpec,
  cleanupProjects,
  makeManager,
} from "./__fixtures__/manager-fakes"
import type { ManagedStartSpec } from "./types"

afterEach(cleanupProjects)

class ObservableRunner extends FakeRunner {
  readonly #startWaiters: Array<(spec: ManagedStartSpec) => void> = []

  override start(spec: ManagedStartSpec): Promise<ManagedChildHandle> {
    const result = super.start(spec)
    this.#startWaiters.shift()?.(spec)
    return result
  }

  nextStart(): Promise<ManagedStartSpec> {
    return new Promise((resolve) => {
      this.#startWaiters.push(resolve)
    })
  }
}

function fallbackPlanner() {
  return () => ({
    kind: "resolved" as const,
    plan: {
      model: "vendor-a/primary-model",
      requested_model: {
        source: "category" as const,
        provider: "vendor-a",
        model_id: "primary-model",
        display: "vendor-a/primary-model",
      },
      resolved_model: {
        source: "category" as const,
        provider: "vendor-a",
        model_id: "primary-model",
        display: "vendor-a/primary-model",
      },
      fallback_models: [
        {
          source: "category" as const,
          provider: "vendor-b",
          model_id: "fallback-model",
          display: "vendor-b/fallback-model",
        },
      ],
      category: "quick",
    },
  })
}

describe("TaskManager configured runtime fallback", () => {
  test("#given a provider failure before any tool call #when the child terminates #then the same task hands off to the next configured model", async () => {
    // given
    const runner = new ObservableRunner()
    const { manager, store } = makeManager({
      planner: fallbackPlanner(),
      inProcess: runner,
    })
    const initialStart = runner.nextStart()
    const result = await manager.start(baseSpec({ execution_mode: "in-process" }))
    if (result.kind !== "started") throw new Error("expected started task")
    await initialStart
    const firstHandle = runner.handles.get(result.task_id)
    if (firstHandle === undefined) throw new Error("expected initial handle")
    expect(store.load(result.task_id)).toMatchObject({
      model: "vendor-a/primary-model",
      requested_model: { display: "vendor-a/primary-model" },
      resolved_model: { display: "vendor-a/primary-model" },
      fallback_models: [{ display: "vendor-b/fallback-model" }],
    })
    const fallbackStart = runner.nextStart()
    const terminal = manager.waitFor(result.task_id)

    // when
    firstHandle.settle({
      status: "error",
      failure: {
        kind: "child-turn-failed",
        message: "provider capacity exhausted",
      },
    })

    // then the fallback launch wins the race against terminal settlement
    const firstOutcome = await Promise.race([
      fallbackStart.then((spec) => ({ kind: "fallback" as const, spec })),
      terminal.then((record) => ({ kind: "terminal" as const, record })),
    ])
    expect(firstOutcome.kind).toBe("fallback")
    if (firstOutcome.kind !== "fallback") throw new Error("expected fallback handoff")
    expect(firstOutcome.spec.model).toBe("vendor-b/fallback-model")
    expect(store.load(result.task_id)).toMatchObject({
      status: "running",
      model: "vendor-b/fallback-model",
      requested_model: { display: "vendor-a/primary-model" },
      resolved_model: { display: "vendor-b/fallback-model" },
      fallback_models: [],
    })

    const secondHandle = runner.handles.get(result.task_id)
    if (secondHandle === undefined) throw new Error("expected fallback handle")
    const completed = manager.waitFor(result.task_id)
    secondHandle.settle({
      status: "completed",
      finalResponse: "completed after fallback",
    })
    expect(await completed).toMatchObject({
      status: "completed",
      model: "vendor-b/fallback-model",
      final_response: "completed after fallback",
    })
  })

  test("#given a failed child already executed a tool #when it terminates #then manager fallback does not replay the task", async () => {
    // given
    const runner = new ObservableRunner()
    const { manager } = makeManager({
      planner: fallbackPlanner(),
      process: runner,
    })
    const started = runner.nextStart()
    const result = await manager.start(baseSpec({ execution_mode: "process" }))
    if (result.kind !== "started") throw new Error("expected started task")
    await started
    const handle = runner.handles.get(result.task_id)
    if (handle === undefined) throw new Error("expected process handle")
    const terminal = manager.waitFor(result.task_id)
    handle.emit({ type: "tool_execution_start", toolName: "write", args: {} })

    // when
    handle.settle({
      status: "error",
      failure: {
        kind: "child-turn-failed",
        message: "provider capacity exhausted",
      },
    })

    // then
    expect(await terminal).toMatchObject({ status: "error" })
    expect(runner.startedSpecs).toHaveLength(1)
  })
})
