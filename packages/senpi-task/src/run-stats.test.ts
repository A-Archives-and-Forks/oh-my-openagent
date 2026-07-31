import { describe, expect, test } from "bun:test"

import { createRunStatsTracker } from "./run-stats"

describe("run stats tracker", () => {
  test("#given assistant turns with usage #when snapshotted #then totals and tps derive from generation time", () => {
    // given
    let nowMs = 1_000
    const tracker = createRunStatsTracker(1_000, () => nowMs)

    // when: first generation window 1s -> 100 output tokens
    nowMs = 2_000
    tracker.accept({ type: "message_start", message: { role: "assistant", content: [] } })
    nowMs = 3_000
    tracker.accept({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "hi" }], usage: { output: 100, totalTokens: 400 } },
    })
    tracker.accept({ type: "tool_execution_start", toolName: "read", args: {} })
    nowMs = 9_000
    tracker.accept({ type: "tool_execution_end", toolName: "read" })
    // second generation window 1s -> 50 output tokens (no message_start: boundary comes from tool end)
    nowMs = 10_000
    tracker.accept({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "done" }], usage: { output: 50, totalTokens: 600 } },
    })

    // then
    expect(tracker.snapshot(11_000)).toEqual({
      runtime_ms: 10_000,
      turns: 2,
      tool_calls: 1,
      output_tokens: 150,
      total_tokens: 1_000,
      generation_ms: 2_000,
      tokens_per_second: 75,
    })
  })

  test("#given non-assistant messages and missing usage #when snapshotted #then only counted facts appear", () => {
    // given
    const tracker = createRunStatsTracker(1_000, () => 1_500)

    // when
    tracker.accept({ type: "message_end", message: { role: "user", content: "hello" } })
    tracker.accept({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } })

    // then
    expect(tracker.snapshot(2_000)).toEqual({
      runtime_ms: 1_000,
      turns: 1,
      tool_calls: 0,
      generation_ms: 500,
    })
  })

  test("#given snake_case usage fields #when accumulated #then they are read as a fallback", () => {
    // given
    let nowMs = 1_000
    const tracker = createRunStatsTracker(1_000, () => nowMs)

    // when
    nowMs = 2_000
    tracker.accept({
      type: "message_end",
      message: { role: "assistant", content: [], usage: { output_tokens: 30, total_tokens: 90 } },
    })

    // then
    const snapshot = tracker.snapshot(2_000)
    expect(snapshot.output_tokens).toBe(30)
    expect(snapshot.total_tokens).toBe(90)
    expect(snapshot.tokens_per_second).toBe(30)
  })

  test("#given a sub-10 tps run #when snapshotted #then tps keeps one decimal", () => {
    // given
    let nowMs = 1_000
    const tracker = createRunStatsTracker(1_000, () => nowMs)

    // when: 10 tokens over 4s -> 2.5 tok/s
    nowMs = 5_000
    tracker.accept({
      type: "message_end",
      message: { role: "assistant", content: [], usage: { output: 10, totalTokens: 10 } },
    })

    // then
    expect(tracker.snapshot(5_000).tokens_per_second).toBe(2.5)
  })

  test("#given message_start before message_end #when snapshotted #then the window is the arrival-clock gap", () => {
    // given
    let nowMs = 10_000
    const tracker = createRunStatsTracker(10_000, () => nowMs)

    // when: streaming observed from arrival of message_start to arrival of message_end
    tracker.accept({ type: "message_start", message: { role: "assistant", content: [] } })
    nowMs = 13_000
    tracker.accept({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "done" }], usage: { output: 300, totalTokens: 600 } },
    })

    // then
    const snapshot = tracker.snapshot(13_000)
    expect(snapshot.generation_ms).toBe(3_000)
    expect(snapshot.tokens_per_second).toBe(100)
  })

  test("#given bursty delivery collapsing the only generation window #when snapshotted #then tps is omitted as unverifiable", () => {
    // given
    let nowMs = 1_000
    const tracker = createRunStatsTracker(1_000, () => nowMs)

    // when: message_end arrives at the same millisecond as spawn (post-hoc burst)
    tracker.accept({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "done" }], usage: { output: 400, totalTokens: 900 } },
    })

    // then: the single token-bearing generation window collapsed to zero measured duration, so
    // generation throughput is unknowable (runtime would conflate tool/idle time with streaming
    // speed). tokens_per_second MUST be absent, not a runtime-derived substitute.
    const snapshot = tracker.snapshot(3_000)
    expect(snapshot.generation_ms).toBeUndefined()
    expect(snapshot.tokens_per_second).toBeUndefined()
  })

  test("#given one measured window and one token-bearing collapsed window #when snapshotted #then tps is omitted as unverifiable", () => {
    // given
    let nowMs = 1_000
    const tracker = createRunStatsTracker(1_000, () => nowMs)

    // when: first turn measures 2s of generation, second turn arrives in the same ms (burst)
    nowMs = 2_000
    tracker.accept({ type: "message_start", message: { role: "assistant", content: [] } })
    nowMs = 4_000
    tracker.accept({
      type: "message_end",
      message: { role: "assistant", content: [], usage: { output: 100, totalTokens: 200 } },
    })
    tracker.accept({
      type: "message_end",
      message: { role: "assistant", content: [], usage: { output: 300, totalTokens: 600 } },
    })

    // then: one measured window (2s) and one token-bearing collapsed window (0s). Dividing all
    // 400 output tokens by only the measured 2s would overstate tps; dividing by runtime would
    // conflate streaming speed with tool/idle time. Either way the collapsed portion's timing is
    // lost, so generation throughput is UNKNOWABLE and tokens_per_second MUST be absent.
    const snapshot = tracker.snapshot(10_000)
    expect(snapshot.runtime_ms).toBe(9_000)
    expect(snapshot.output_tokens).toBe(400)
    expect(snapshot.total_tokens).toBe(800)
    expect(snapshot.generation_ms).toBe(2_000)
    expect(snapshot.tokens_per_second).toBeUndefined()
  })
})
