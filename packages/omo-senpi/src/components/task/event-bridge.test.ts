import { describe, expect, it } from "bun:test"

import type { SessionShutdownEvent } from "@code-yeongyu/senpi"
import type { SuspendInput, SuspendSummary, TaskLifecycle } from "@oh-my-opencode/senpi-task"

import { FakeExtensionAPI } from "../../../test-support/fake-extension-api"
import type { ComponentContext } from "../../extension/types"
import { wireEventBridge } from "./event-bridge"
import type { TaskEngine } from "./engine"
import type { SessionTransitionBridge } from "./session-transition-bridge"
import type { TaskStatusUi } from "./status-ui"

const fakeSummary: SuspendSummary = {
  suspended_in_process: 0,
  suspended_rpc: 0,
  suspended_pending: 0,
  disposed: 0,
  failures: [],
}

function wireHarness(sessionId?: string) {
  const pi = new FakeExtensionAPI()
  const calls: SuspendInput[] = []
  const order: string[] = []
  const warnings: Array<{ message: string; details?: unknown }> = []

  const engine = {
    runtime: {
      captureFrom: () => {},
      sessionId: () => sessionId,
      clearUi: () => {
        order.push("clearUi")
      },
      parentState: () => ({ kind: "idle" as const }),
    },
    lifecycle: {
      suspendOnSessionShutdown: async (input: SuspendInput) => {
        calls.push(input)
        order.push("suspend")
        return fakeSummary
      },
      destroyResidentTask: async () => {},
      admitResident: async () => ({ kind: "admitted" as const }),
      reconcileOnSessionStart: async () => ({ outcomes: [] }),
      cleanupExpiredRecords: () => ({ deleted: [] as readonly string[], retained: [] as readonly string[] }),
    } satisfies Partial<TaskLifecycle> as unknown as TaskLifecycle,
    manager: { get: () => undefined } as unknown as TaskEngine["manager"],
    notifier: { reconcileFailedNotifications: () => {} } as unknown as TaskEngine["notifier"],
    planner: {} as TaskEngine["planner"],
    agents: {},
    omoConfig: {} as TaskEngine["omoConfig"],
    settings: {} as TaskEngine["settings"],
    stateDir: "",
    memberLiveness: { acknowledgePersisted: async () => {} } as unknown as TaskEngine["memberLiveness"],
    notifyOwnedMemberLiveness: async () => {},
    appendTaskEvent: () => {},
    onStoreMutation: () => () => {},
  } as unknown as TaskEngine

  const statusUi = {
    scheduleSync: () => {},
    syncNow: () => {},
    dispose: () => {
      order.push("dispose")
    },
  } as unknown as TaskStatusUi

  const transitions = {
    onBeforeSwitch: () => {},
    onBeforeCompact: () => {},
    onCompact: () => {},
    onShutdown: () => {
      order.push("transition")
    },
    onSessionStart: () => {},
  } as unknown as SessionTransitionBridge

  const state = {
    reconcileTeamMailbox: async () => {},
    leadPollers: {
      tick: async () => {},
      shutdown: () => {
        order.push("leadShutdown")
      },
    },
  } as unknown as Parameters<typeof wireEventBridge>[5]

  const ctx = {
    logger: {
      info: () => {},
      warn: (message: string, details?: unknown) => {
        warnings.push({ message, details })
      },
      error: () => {},
    },
    config: { getFlag: () => undefined },
  } as unknown as ComponentContext

  wireEventBridge(pi, ctx, engine, statusUi, transitions, state)

  return { pi, calls, order, warnings }
}

describe("event-bridge session_shutdown", () => {
  it("#given a session_shutdown with a reason and a captured session id #when the event fires #then it suspends with parentSessionId and reason", async () => {
    // given
    const { pi, calls, order } = wireHarness("parent-session")

    // when
    await pi.dispatch(
      "session_shutdown",
      { type: "session_shutdown", reason: "quit" } as SessionShutdownEvent,
      {},
    )

    // then
    expect(order).toEqual(["transition", "clearUi", "dispose", "leadShutdown", "suspend"])
    expect(calls).toEqual([{ parentSessionId: "parent-session", reason: "quit" }])
  })

  it("#given a session_shutdown with no captured session id #when the event fires #then it warns and does not suspend", async () => {
    // given
    const { pi, calls, order, warnings } = wireHarness(undefined)

    // when
    await pi.dispatch(
      "session_shutdown",
      { type: "session_shutdown", reason: "reload" } as SessionShutdownEvent,
      {},
    )

    // then
    expect(order).toEqual(["transition", "clearUi", "dispose", "leadShutdown"])
    expect(calls).toHaveLength(0)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.message).toContain("session id")
  })

  it("#given a session_shutdown with a missing reason #when the event fires #then it warns and does not suspend", async () => {
    // given
    const { pi, calls, warnings } = wireHarness("parent-session")

    // when
    await pi.dispatch("session_shutdown", { type: "session_shutdown" } as unknown as SessionShutdownEvent, {})

    // then
    expect(calls).toHaveLength(0)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.message).toContain("reason")
  })
})
