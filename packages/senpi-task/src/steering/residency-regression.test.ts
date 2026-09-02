import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"

import { createTaskRecord } from "../state"
import type { TaskRecord } from "../state"
import { FakeRunner } from "../manager/__fixtures__/manager-fakes"
import { createTaskManager } from "../manager/manager"
import { createTaskRecordStore } from "../store"
import type { RpcChildHandle } from "../runners/types"
import type { ManagedChildHandle } from "../manager/child-handle"
import type { SteeringPort } from "./types"
import { createSteeringEngine } from "./engine"
import { createTaskLifecycle } from "../lifecycle/create"
import { FakeRegistry, settings } from "../lifecycle/__fixtures__/lifecycle-fakes"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function detachedTerminal(store: ReturnType<typeof createTaskRecordStore>): TaskRecord {
  const record = createTaskRecord({
    parent_session_id: "parent",
    root_session_id: "parent",
    depth: 1,
    execution_mode: "process",
    model: "anthropic/claude",
    notify_on_terminal: false,
  })
  const terminal: TaskRecord = {
    ...record,
    task_id: "st_75500009",
    status: "completed",
    residency_state: "rpc_detached",
    final_response: "first pass",
    spawn_spec: { cwd: "/tmp/project" },
    terminal_at: "2026-09-01T00:00:00.000Z",
  }
  store.save(terminal)
  const sessionDir = join(store.stateDir, "children", terminal.task_id, "sessions", terminal.task_id)
  mkdirSync(sessionDir, { recursive: true })
  writeFileSync(join(sessionDir, "resume.jsonl"), "{\"role\":\"assistant\"}\n")
  return terminal
}

function fakeHandle(taskId: string, followUps: string[]): ManagedChildHandle {
  return {
    task_id: taskId,
    sessionId: `session:${taskId}`,
    pid: 7000,
    steer: async () => undefined,
    followUp: async (message) => { followUps.push(message) },
    abort: async () => undefined,
    subscribe: () => () => undefined,
    waitForOutcome: () => new Promise(() => undefined),
    lastAssistantText: () => undefined,
    dispose: async () => undefined,
  }
}

function rpcHandle(taskId: string, followUps: string[]): RpcChildHandle {
  return {
    task_id: taskId,
    sessionId: `session:${taskId}`,
    pid: 7000,
    steer: async () => undefined,
    followUp: async (message) => { followUps.push(message) },
    abort: async () => undefined,
    subscribe: () => () => undefined,
    waitForIdle: () => new Promise(() => undefined),
    lastAssistantText: () => undefined,
    dispose: async () => undefined,
    terminate: async () => undefined,
    exitOutcome: () => undefined,
    waitForExit: async () => ({ kind: "clean", facts: { pid: 7000, code: 0, signal: null, stderrTail: "" } }),
    lastSeen: () => undefined,
    switchSession: async () => ({ cancelled: false }),
  }
}

function portFor(
  store: ReturnType<typeof createTaskRecordStore>,
  revived: ManagedChildHandle | undefined,
  reviveReasons: string[],
  startLive = false,
): SteeringPort {
  let live = startLive
  return {
    store,
    liveHandle: () => live ? revived : undefined,
    reserveForRevive: () => ({
      ok: true,
      commit: () => undefined,
      release: () => undefined,
    }),
    reviveDetached: async (taskId) => {
      if (revived === undefined) {
        reviveReasons.push("respawn failed")
        return { ok: false, reason: "respawn failed" }
      }
      live = true
      store.mutate(taskId, (record) => ({ ...record, residency_state: "resident", host_pid: 6000 }))
      reviveReasons.push("revived")
      return { ok: true }
    },
    dequeuePending: () => false,
    destruction: { destroyResidentTask: async () => undefined },
    runStatsSnapshot: () => undefined,
    now: () => Date.parse("2026-09-02T00:00:00.000Z"),
  }
}

describe("task_send lazy terminal RPC revival", () => {
  test("#given a detached terminal process with a transcript #when manager task_send targets it #then exactly one RPC child is respawned and the message revives the record", async () => {
    const project = mkdtempSync(join(tmpdir(), "senpi-task-steering-manager-"))
    roots.push(project)
    const store = createTaskRecordStore({ project_dir: project })
    const record = detachedTerminal(store)
    const followUps: string[] = []
    let starts = 0
    const manager = createTaskManager({
      store,
      runners: { "in-process": new FakeRunner(), process: new FakeRunner() },
      planner: () => ({ kind: "resolved", plan: { model: "anthropic/claude" } }),
      config: settings(),
      cwd: project,
      rpcRespawnRunner: {
        start: async (spec) => {
          starts += 1
          return rpcHandle(spec.task_id, followUps)
        },
      },
    })
    const lifecycle = createTaskLifecycle({ store, registry: new FakeRegistry(), config: settings() })

    const outcome = await manager.sendToTask({ idOrName: record.task_id, message: "second pass" })

    expect(outcome.kind).toBe("revived")
    expect(starts).toBe(1)
    expect(followUps).toEqual(["second pass"])
    expect(store.load(record.task_id)?.status).toBe("running")
    expect(store.load(record.task_id)?.residency_state).toBe("resident")
    expect(store.load(record.task_id)?.terminal_at).toBeUndefined()
    lifecycle.dispose?.()
  })

  test("#given the detached terminal RPC respawn fails #when manager task_send targets it #then it returns not-continuable and rolls back to detached", async () => {
    const project = mkdtempSync(join(tmpdir(), "senpi-task-steering-manager-failure-"))
    roots.push(project)
    const store = createTaskRecordStore({ project_dir: project })
    const record = detachedTerminal(store)
    const lifecycle = createTaskLifecycle({ store, registry: new FakeRegistry(), config: settings() })
    const manager = createTaskManager({
      store,
      runners: { "in-process": new FakeRunner(), process: new FakeRunner() },
      planner: () => ({ kind: "resolved", plan: { model: "anthropic/claude" } }),
      config: settings(),
      cwd: project,
      rpcRespawnRunner: { start: async () => { throw new Error("respawn unavailable") } },
    })

    const outcome = await manager.sendToTask({ idOrName: record.task_id, message: "retry" })

    expect(outcome.kind).toBe("not_continuable")
    if (outcome.kind === "not_continuable") expect(outcome.reason).toContain("could not be revived")
    expect(store.load(record.task_id)?.residency_state).toBe("rpc_detached")
    expect(store.load(record.task_id)?.host_pid).toBeUndefined()
    lifecycle.dispose?.()
  })
  test("#given a terminal rpc_detached record with a transcript #when task_send sends a message #then one detached revival happens and the message is delivered", async () => {
    const project = mkdtempSync(join(tmpdir(), "senpi-task-steering-regression-"))
    roots.push(project)
    const store = createTaskRecordStore({ project_dir: project })
    const record = detachedTerminal(store)
    const followUps: string[] = []
    const reviveReasons: string[] = []
    const handle = fakeHandle(record.task_id, followUps)
    const engine = createSteeringEngine(portFor(store, handle, reviveReasons))

    const outcome = await engine.sendToTask({ idOrName: record.task_id, message: "second pass" })

    expect(outcome.kind).toBe("revived")
    expect(followUps).toEqual(["second pass"])
    expect(reviveReasons).toEqual(["revived"])
  })

  test("#given a resident terminal record with terminal_at #when task_send revives it #then the new running record drops the old terminal anchor", async () => {
    const project = mkdtempSync(join(tmpdir(), "senpi-task-steering-terminal-at-"))
    roots.push(project)
    const store = createTaskRecordStore({ project_dir: project })
    const record = detachedTerminal(store)
    store.mutate(record.task_id, (fresh) => ({ ...fresh, residency_state: "resident", host_pid: 6000 }))
    const followUps: string[] = []
    const reviveReasons: string[] = []
    const engine = createSteeringEngine(portFor(store, fakeHandle(record.task_id, followUps), reviveReasons, true))

    const outcome = await engine.sendToTask({ idOrName: record.task_id, message: "new run" })

    expect(outcome.kind).toBe("revived")
    expect(store.load(record.task_id)?.status).toBe("running")
    expect(store.load(record.task_id)?.terminal_at).toBeUndefined()
    expect(followUps).toEqual(["new run"])
  })

  test("#given detached terminal revival fails #when task_send sends a message #then it returns not-continuable and leaves the record detached", async () => {
    const project = mkdtempSync(join(tmpdir(), "senpi-task-steering-failure-"))
    roots.push(project)
    const store = createTaskRecordStore({ project_dir: project })
    const record = detachedTerminal(store)
    const reviveReasons: string[] = []
    const engine = createSteeringEngine(portFor(store, undefined, reviveReasons))

    const outcome = await engine.sendToTask({ idOrName: record.task_id, message: "retry" })

    expect(outcome.kind).toBe("not_continuable")
    if (outcome.kind === "not_continuable") expect(outcome.reason).toContain("respawn failed")
    expect(store.load(record.task_id)?.residency_state).toBe("rpc_detached")
    expect(reviveReasons).toEqual(["respawn failed"])
  })
})
