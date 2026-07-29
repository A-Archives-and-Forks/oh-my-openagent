import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, test } from "bun:test"
import { loadOmoConfig } from "@oh-my-opencode/omo-config-core"
import type { ManagedChildHandle, ManagedRunner, ManagedStartSpec, RunnerOutcome, TaskRecord } from "@oh-my-opencode/senpi-task"

import { FakeExtensionAPI } from "../../../test-support/fake-extension-api"
import { IdleInjectionCoordinator } from "../../extension/idle-injection-coordinator"
import { composeTaskEngine } from "./engine"
import {
  TEAM_MEMBER_LIVENESS_MESSAGE_TYPE,
  createTeamMemberLivenessNotifier,
} from "./member-liveness"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function memberRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    task_id: "st_00000001",
    name: "team:11111111-1111-4111-8111-111111111111:alpha",
    parent_session_id: "lead-session",
    root_session_id: "lead-session",
    depth: 1,
    execution_mode: "process",
    model: "omo-mock/mock-1",
    status: "error",
    residency_state: "resident",
    created_at: "2026-07-26T00:00:00.000Z",
    updated_at: "2026-07-26T00:00:01.000Z",
    error_message: "RPC child killed by signal SIGKILL",
    killed: true,
    notification: { run_epoch: 0, notified_epoch: -1 },
    ...overrides,
  }
}

describe("team member liveness notifier", () => {
  test("#given a SIGKILL member exit while the lead streams #when the terminal record is observed #then one liveness injection reaches the lead with the member and last state", () => {
    // given
    const pi = new FakeExtensionAPI()
    const scheduled: Array<() => void> = []
    const coordinator = new IdleInjectionCoordinator(
      (message, options) => pi.sendMessage(message, { triggerTurn: true, deliverAs: options.deliverAs }),
      { scheduleFlush: (flush) => scheduled.push(flush) },
    )
    const notifier = createTeamMemberLivenessNotifier({
      pi,
      coordinator,
      isStreaming: () => true,
    })

    // when
    notifier.notifyTerminal(memberRecord())
    notifier.notifyTerminal(memberRecord())
    for (const flush of scheduled) flush()

    // then
    expect(pi.userMessages).toEqual([])
    expect(pi.messages).toEqual([{
      message: {
        customType: "omo-senpi:wake",
        content: "Team member liveness: alpha exited abnormally; last known state: error. Reason: RPC child killed by signal SIGKILL",
        display: false,
        details: [{
          customType: TEAM_MEMBER_LIVENESS_MESSAGE_TYPE,
          details: {
            memberName: "alpha",
            lastKnownState: "error",
            reason: "RPC child killed by signal SIGKILL",
            deliveryKey: "team-member-liveness:st_00000001:0",
          },
        }],
      },
      options: { triggerTurn: true, deliverAs: "steer" },
    }])
  })

  test("#given a queued team liveness event #when only its matching delivery key is observed #then the durable epoch is marked exactly once", () => {
    // given
    const pi = new FakeExtensionAPI()
    const scheduled: Array<() => void> = []
    const persisted: number[] = []
    const coordinator = new IdleInjectionCoordinator(
      (message, options) => pi.sendMessage(message, { triggerTurn: true, deliverAs: options.deliverAs }),
      { scheduleFlush: (flush) => scheduled.push(flush) },
    )
    const notifier = createTeamMemberLivenessNotifier({
      pi,
      coordinator,
      isStreaming: () => true,
      markDelivered: (record) => persisted.push(record.notification.run_epoch),
    })

    // when queued but not delivered
    notifier.notifyTerminal(memberRecord())

    // then no premature durable marker
    expect(persisted).toEqual([])

    // when sendMessage returns but no later lifecycle boundary has confirmed progress
    for (const flush of scheduled) flush()

    // then there is still no premature durable marker
    expect(persisted).toEqual([])

    // when an unrelated delivery is observed
    notifier.acknowledgeDelivered("team-member-liveness:st_unrelated:0")

    // then it cannot acknowledge this record
    expect(persisted).toEqual([])

    // when the exact liveness delivery is observed twice
    notifier.acknowledgeDelivered("team-member-liveness:st_00000001:0")
    notifier.acknowledgeDelivered("team-member-liveness:st_00000001:0")

    // then the delivered epoch is persisted once
    expect(persisted).toEqual([0])
  })

  test("#given the liveness epoch is already persisted #when a restarted notifier observes the terminal record #then it does not enqueue a duplicate", () => {
    // given
    const pi = new FakeExtensionAPI()
    const coordinator = new IdleInjectionCoordinator(
      (message, options) => pi.sendMessage(message, { triggerTurn: true, deliverAs: options.deliverAs }),
    )
    const notifier = createTeamMemberLivenessNotifier({
      pi,
      coordinator,
      isStreaming: () => false,
      wasDelivered: () => true,
    })

    // when
    notifier.notifyTerminal(memberRecord())
    coordinator.flushOnIdle()

    // then
    expect(pi.messages).toEqual([])
  })

  test("#given a process member killed by SIGKILL #when the manager observes its terminal outcome #then the wired lead notifier injects liveness", async () => {
    // given
    const root = mkdtempSync(join(tmpdir(), "omo-senpi-member-liveness-"))
    roots.push(root)
    const pi = new FakeExtensionAPI()
    const crashing = createCrashingRunner()
    const engine = composeTaskEngine({
      pi,
      omoConfig: loadOmoConfig({ cwd: root }).config,
      cwd: root,
      sharedParentTools: () => [],
      runnerFactories: { inProcess: () => crashing.runner, process: () => crashing.runner },
    })
    const started = await engine.manager.start({
      prompt: "member work",
      name: "team:11111111-1111-4111-8111-111111111111:alpha",
      parent_session_id: "lead-session",
      depth: 1,
      execution_mode: "process",
      model: "omo-mock/mock-1",
      run_in_background: true,
    })
    if (started.kind !== "started") throw new Error("expected member to start")

    // when
    crashing.failSigkill()
    await flushMicrotasks()

    // then
    const liveness = pi.messages.find((entry) => entry.message.customType === TEAM_MEMBER_LIVENESS_MESSAGE_TYPE)
    expect(liveness?.message.details).toEqual({
      memberName: "alpha",
      lastKnownState: "error",
      reason: "RPC child killed by signal SIGKILL",
      deliveryKey: `team-member-liveness:${started.task_id}:0`,
    })
    expect(liveness?.message.display).toBe(false)
    expect(liveness?.options).toEqual({ triggerTurn: true, deliverAs: "steer" })
    expect(engine.manager.get(started.task_id)?.notification.liveness_notified_epoch).toBeUndefined()
    engine.memberLiveness.acknowledgeDelivered(`team-member-liveness:${started.task_id}:0`)
    expect(engine.manager.get(started.task_id)?.notification.liveness_notified_epoch).toBe(0)
  })

  test("#given a normal member completion #when its terminal record is observed #then no liveness event is injected", () => {
    // given
    const sent: Record<string, unknown>[] = []
    const notifier = createTeamMemberLivenessNotifier({
      pi: { sendMessage: (message) => sent.push(message) },
      isStreaming: () => false,
    })

    // when
    notifier.notifyTerminal(memberRecord({ status: "completed", error_message: undefined, killed: undefined }))

    // then
    expect(sent).toEqual([])
    expect(TEAM_MEMBER_LIVENESS_MESSAGE_TYPE).toBe("senpi-task.team-member-liveness")
  })
})

function createCrashingRunner(): { readonly runner: ManagedRunner; failSigkill: () => void } {
  let resolveOutcome: (outcome: RunnerOutcome) => void = () => undefined
  const outcome = new Promise<RunnerOutcome>((resolve) => { resolveOutcome = resolve })
  const runner: ManagedRunner = {
    start: async (spec: ManagedStartSpec): Promise<ManagedChildHandle> => ({
      task_id: spec.taskId,
      sessionId: "member-session",
      pid: 4242,
      steer: async () => undefined,
      followUp: async () => undefined,
      abort: async () => undefined,
      subscribe: () => () => undefined,
      waitForOutcome: () => outcome,
      lastAssistantText: () => undefined,
      terminate: async () => undefined,
      dispose: async () => undefined,
    }),
  }
  return {
    runner,
    failSigkill: () => resolveOutcome({
      status: "error",
      failure: { kind: "child-prompt-failed", message: "RPC child killed by signal SIGKILL" },
      killed: true,
    }),
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}
