/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test"

import { FakeExtensionAPI } from "../../../test-support/fake-extension-api"
import type { ComponentContext, ComponentLogger } from "../../extension/types"
import {
  createTodoContinuityComponent,
  TODO_CONTINUITY_DISABLED_FLAG,
  TODO_CONTINUITY_REMINDER_TYPE,
} from "./index"

const TAG_OPEN = "<omo-todo-continuity>"
const TAG_CLOSE = "</omo-todo-continuity>"

function componentContext(pi: FakeExtensionAPI): ComponentContext {
  const logger: ComponentLogger = { info() {}, warn() {}, error() {} }
  return { logger, config: { getFlag: (name) => pi.getFlag(name) } }
}

function todoEntries(status = "pending"): readonly unknown[] {
  return [
    {
      type: "custom",
      customType: "senpi.todo-state",
      data: {
        schema: "v2",
        phases: [
          {
            name: "Current",
            tasks: [
              { content: "keep alpha", status },
              { content: "keep beta", status: "pending" },
            ],
          },
        ],
      },
    },
  ]
}

function eventContext(entries: readonly unknown[] | Error): Record<string, unknown> {
  return {
    cwd: "/repo",
    sessionManager: {
      getBranch() {
        if (entries instanceof Error) throw entries
        return entries
      },
    },
  }
}

async function setup(options: { disabled?: boolean } = {}): Promise<FakeExtensionAPI> {
  const pi = new FakeExtensionAPI()
  if (options.disabled === true) pi.setFlag(TODO_CONTINUITY_DISABLED_FLAG, true)
  await createTodoContinuityComponent().register(pi, componentContext(pi))
  return pi
}

describe("todo-continuity component", () => {
  describe("#given open todos and an idle user input", () => {
    it("#then it sends one hidden reminder without changing the typed prompt", async () => {
      const pi = await setup()

      const [result] = await pi.dispatch(
        "input",
        { type: "input", text: "also add gamma", source: "interactive" },
        eventContext(todoEntries()),
      )

      expect(result).toEqual({ action: "continue" })
      expect(pi.messages).toHaveLength(1)
      expect(pi.messages[0]?.message).toMatchObject({
        customType: TODO_CONTINUITY_REMINDER_TYPE,
        display: false,
      })
      const content = String(pi.messages[0]?.message["content"])
      expect(content.startsWith(TAG_OPEN)).toBe(true)
      expect(content.endsWith(TAG_CLOSE)).toBe(true)
      expect(content).toContain("todo view")
      expect(content).toContain("keep alpha")
    })
  })

  describe("#given open todos and a queued user input", () => {
    it("#then steer and followUp append the reminder atomically and preserve images", async () => {
      for (const streamingBehavior of ["steer", "followUp"]) {
        const pi = await setup()
        const images = [{ type: "image", id: streamingBehavior }]

        const [result] = (await pi.dispatch(
          "input",
          {
            type: "input",
            text: "/skill:ultrawork also add gamma",
            source: "interactive",
            streamingBehavior,
            images,
          },
          eventContext(todoEntries()),
        )) as Array<{ action: string; text: string; images?: readonly unknown[] }>

        expect(result.action).toBe("transform")
        expect(result.text.startsWith("/skill:ultrawork also add gamma\n")).toBe(true)
        expect(result.text.match(/<omo-todo-continuity>/g)).toHaveLength(1)
        expect(result.images).toEqual(images)
        expect(pi.messages).toHaveLength(0)
      }
    })
  })

  describe("#given no actionable todo state", () => {
    it("#then terminal, empty, and malformed states inject nothing", async () => {
      const cases: readonly (readonly unknown[])[] = [
        [],
        [
          {
            type: "custom",
            customType: "senpi.todo-state",
          data: {
            schema: "v2",
            phases: [
              {
                name: "Done",
                tasks: [
                  { content: "done", status: "completed" },
                  { content: "dropped", status: "abandoned" },
                  { content: "cancelled", status: "cancelled" },
                ],
              },
            ],
          },
          },
        ],
        [{ type: "custom", customType: "senpi.todo-state", data: { malformed: true } }],
      ]

      for (const entries of cases) {
        const pi = await setup()
        const [result] = await pi.dispatch(
          "input",
          { type: "input", text: "hello", source: "interactive" },
          eventContext(entries),
        )

        expect(result).toEqual({ action: "continue" })
        expect(pi.messages).toHaveLength(0)
      }
    })
  })

  describe("#given an unsafe or unsupported input context", () => {
    it("#then extension input, paired tags, missing APIs, and thrown reads are skipped", async () => {
      const cases: Array<{ payload: Record<string, unknown>; ctx: unknown }> = [
        {
          payload: { type: "input", text: "extension wake", source: "extension" },
          ctx: eventContext(todoEntries()),
        },
        {
          payload: { type: "input", text: `${TAG_OPEN}copied${TAG_CLOSE}`, source: "interactive" },
          ctx: eventContext(todoEntries()),
        },
        {
          payload: { type: "input", text: "missing session", source: "interactive" },
          ctx: { cwd: "/repo" },
        },
        {
          payload: { type: "input", text: "throwing session", source: "interactive" },
          ctx: eventContext(new Error("boom")),
        },
      ]

      for (const { payload, ctx } of cases) {
        const pi = await setup()
        const [result] = await pi.dispatch("input", payload, ctx)
        expect(result).toEqual({ action: "continue" })
        expect(pi.messages).toHaveLength(0)
      }
    })
  })

  it("#given the component is disabled #when input arrives #then it injects nothing", async () => {
    const pi = await setup({ disabled: true })

    const [result] = await pi.dispatch(
      "input",
      { type: "input", text: "hello", source: "interactive" },
      eventContext(todoEntries()),
    )

    expect(result).toEqual({ action: "continue" })
    expect(pi.messages).toHaveLength(0)
  })
})
