import { afterEach, describe, expect, test } from "bun:test"

import { baseSpec, cleanupProjects, makeManager } from "./__fixtures__/manager-fakes"

afterEach(() => {
  cleanupProjects()
})

describe("manager run stats wiring", () => {
  test("#given a spawned child #when it completes #then the terminal record carries accumulated run stats", async () => {
    // given
    const { manager, store, inProcess } = makeManager()
    const started = await manager.start(baseSpec())
    if (started.kind !== "started") throw new Error(`unexpected start result: ${started.kind}`)
    const fake = inProcess.handles.get(started.task_id)
    if (fake === undefined) throw new Error("fake handle missing")

    // when
    fake.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "working" }],
        usage: { output: 120, totalTokens: 300 },
      },
    })
    fake.emit({ type: "tool_execution_start", toolName: "read", args: { path: "a.ts" } })
    fake.settle({ status: "completed", finalResponse: "done" })
    const final = await manager.waitFor(started.task_id)

    // then
    expect(final.status).toBe("completed")
    const record = store.load(started.task_id)
    expect(record?.run_stats?.turns).toBe(1)
    expect(record?.run_stats?.tool_calls).toBe(1)
    expect(record?.run_stats?.output_tokens).toBe(120)
    expect(record?.run_stats?.total_tokens).toBe(300)
    expect(record?.run_stats?.runtime_ms).toBeGreaterThanOrEqual(0)
  })

  test("#given a spawned child #when it fails #then run stats persist on the error record", async () => {
    // given
    const { manager, store, inProcess } = makeManager()
    const started = await manager.start(baseSpec())
    if (started.kind !== "started") throw new Error(`unexpected start result: ${started.kind}`)
    const fake = inProcess.handles.get(started.task_id)
    if (fake === undefined) throw new Error("fake handle missing")

    // when
    fake.emit({ type: "tool_execution_start", toolName: "bash", args: { command: "ls" } })
    fake.settle({ status: "error", failure: { kind: "child-turn-failed", message: "boom" } })
    const final = await manager.waitFor(started.task_id)

    // then
    expect(final.status).toBe("error")
    expect(store.load(started.task_id)?.run_stats?.tool_calls).toBe(1)
  })

  test("#given a spawned child #when it is cancelled #then run stats persist on the cancelled record", async () => {
    // given
    const { manager, store, inProcess } = makeManager()
    const started = await manager.start(baseSpec())
    if (started.kind !== "started") throw new Error(`unexpected start result: ${started.kind}`)
    const fake = inProcess.handles.get(started.task_id)
    if (fake === undefined) throw new Error("fake handle missing")

    // when
    fake.emit({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "partial" }], usage: { output: 10, totalTokens: 20 } },
    })
    fake.settle({ status: "cancelled" })
    const final = await manager.waitFor(started.task_id)

    // then
    expect(final.status).toBe("cancelled")
    expect(store.load(started.task_id)?.run_stats?.turns).toBe(1)
  })
})
