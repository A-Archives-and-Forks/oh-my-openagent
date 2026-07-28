/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test"

import { summarizeLatestTodoState } from "./todo-state"

const TODO_STATE_TYPE = "senpi.todo-state"

function customState(data: unknown): Record<string, unknown> {
  return { type: "custom", customType: TODO_STATE_TYPE, data }
}

function toolResult(toolName: string, details: unknown): Record<string, unknown> {
  return {
    type: "message",
    message: { role: "toolResult", toolName, details },
  }
}

describe("summarizeLatestTodoState", () => {
  it("#given v2 phases #when summarized #then it counts open work and prefers the in-progress task", () => {
    const summary = summarizeLatestTodoState([
      customState({
        schema: "v2",
        phases: [
          {
            name: "Build",
            tasks: [
              { content: "pending item", status: "pending" },
              { content: "active item", status: "in_progress" },
              { content: "finished item", status: "completed" },
            ],
          },
        ],
      }),
    ])

    expect(summary).toEqual({ open: 2, total: 3, next: "active item" })
  })

  it("#given legacy todos #when an unknown status appears #then it remains open", () => {
    const summary = summarizeLatestTodoState([
      customState({
        todos: [
          { content: "blocked by review", status: "blocked", priority: "high" },
          { content: "cancelled item", status: "cancelled", priority: "low" },
        ],
      }),
    ])

    expect(summary).toEqual({ open: 1, total: 2, next: "blocked by review" })
  })

  it("#given todo tool-result details #when summarized #then both todo aliases are accepted", () => {
    for (const toolName of ["todo", "todowrite"]) {
      const summary = summarizeLatestTodoState([
        toolResult(toolName, {
          phases: [{ name: "QA", tasks: [{ content: "inspect output", status: "pending" }] }],
        }),
      ])

      expect(summary).toEqual({ open: 1, total: 1, next: "inspect output" })
    }
  })

  it("#given multiple states #when a later parseable state exists #then it wins", () => {
    const summary = summarizeLatestTodoState([
      customState({ todos: [{ content: "stale task", status: "pending" }] }),
      customState({ unexpected: true }),
      customState({
        schema: "v2",
        phases: [{ name: "Latest", tasks: [{ content: "latest task", status: "in_progress" }] }],
      }),
      customState({ malformed: "ignored" }),
    ])

    expect(summary).toEqual({ open: 1, total: 1, next: "latest task" })
  })

  it("#given terminal tasks #when summarized #then it reports zero open work", () => {
    const summary = summarizeLatestTodoState([
      customState({
        todos: [
          { content: "done", status: "completed" },
          { content: "dropped", status: "abandoned" },
          { content: "cancelled", status: "cancelled" },
        ],
      }),
    ])

    expect(summary).toEqual({ open: 0, total: 3, next: undefined })
  })

  it("#given malformed or empty branch data #when summarized #then it degrades to undefined", () => {
    for (const entries of [[], [null], [customState(null)], [customState({ phases: "bad" })]]) {
      expect(summarizeLatestTodoState(entries)).toBeUndefined()
    }
  })

  it("#given multiline task text #when summarized #then the next task is safe for a compact reminder", () => {
    const summary = summarizeLatestTodoState([
      customState({ todos: [{ content: "first line\nsecond\tline", status: "pending" }] }),
    ])

    expect(summary?.next).toBe("first line second line")
  })
})
