import { describe, expect, it } from "bun:test"

import type { SenpiExtensionAPI } from "../../extension/types"
import {
  createDagRpcBridge,
  DAG_ACTIVITY_COALESCE_MS,
  DAG_DEFAULT_HEARTBEAT_MS,
  type DagBridgeActivityEvent,
  type DagBridgeRun,
  type DagBridgeRunEvent,
  type DagRpcBridgeDeps,
} from "./dag-rpc-bridge"

type EmittedEvent = { readonly name: string; readonly data: unknown }

type FakeTimer = { readonly id: number; readonly callback: () => void; readonly ms: number; dueAt: number }

// Deterministic timer seam: nothing fires until the test advances the clock, so no test ever waits
// on wall-clock time.
function fakeTimers() {
  const timers = new Map<number, FakeTimer>()
  let nextId = 1
  let clock = 0
  return {
    seam: {
      set(callback: () => void, ms: number) {
        const id = nextId
        nextId += 1
        timers.set(id, { id, callback, ms, dueAt: clock + ms })
        return id
      },
      clear(handle: number) {
        timers.delete(handle)
      },
    },
    now: () => clock,
    pending: () => timers.size,
    advance(ms: number) {
      const target = clock + ms
      for (;;) {
        const due = [...timers.values()].filter((timer) => timer.dueAt <= target).sort((a, b) => a.dueAt - b.dueAt)[0]
        if (due === undefined) break
        clock = due.dueAt
        timers.delete(due.id)
        due.callback()
      }
      clock = target
    },
  }
}

function fakePi() {
  const emitted: EmittedEvent[] = []
  const pi = {
    on() {},
    rpc: { emit: (name: string, data: unknown) => void emitted.push({ name, data }) },
    registerTool() {},
    registerCommand() {},
    registerFlag() {},
    getFlag: () => undefined,
    sendMessage() {},
    sendUserMessage() {},
  } as unknown as SenpiExtensionAPI
  return { pi, emitted }
}

// A journal stand-in: subscribers receive events only through publish(), mirroring the real journal
// which fans out strictly after the WAL append plus checkpoint replace.
function fakeRun(runId: string, status: DagBridgeRun["status"]) {
  const listeners = new Set<(event: DagBridgeRunEvent) => void>()
  let current = status
  const run: DagBridgeRun = {
    runId,
    get status() {
      return current
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
  }
  return {
    run,
    setStatus(next: DagBridgeRun["status"]) {
      current = next
    },
    publish(event: DagBridgeRunEvent) {
      for (const listener of listeners) listener(event)
    },
  }
}

function runEvent(runId: string, seq: number, type: string): DagBridgeRunEvent {
  return { schemaVersion: 1, runId, seq, at: new Date(seq * 1000).toISOString(), lane: "boundary", type }
}

function activityEvent(runId: string, nodeId: string, activity: string): DagBridgeActivityEvent {
  return { schemaVersion: 1, runId, nodeId, taskId: `st_${nodeId}`, at: "2026-08-14T00:00:00.000Z", activity, turns: 1 }
}

function wire(
  runs: readonly DagBridgeRun[],
  overrides: Partial<DagRpcBridgeDeps> = {},
) {
  const timers = fakeTimers()
  const { pi, emitted } = fakePi()
  const owned = [...runs]
  const bridge = createDagRpcBridge(pi, {
    liveRuns: () => owned,
    timers: timers.seam,
    now: timers.now,
    ...overrides,
  })
  return { bridge, emitted, timers, addRun: (run: DagBridgeRun) => void owned.push(run) }
}

const emittedNames = (emitted: readonly EmittedEvent[], name: string) =>
  emitted.filter((entry) => entry.name === name)

describe("dag rpc bridge", () => {
  describe("#given a journal that fans out post-durability", () => {
    it("#when events arrive #then every event is emitted exactly once on omo.dag.event in seq order", () => {
      // given
      const source = fakeRun("dag_1", "running")
      const { bridge, emitted } = wire([source.run])
      bridge.attach()

      // when
      source.publish(runEvent("dag_1", 1, "dag.run.created"))
      source.publish(runEvent("dag_1", 2, "dag.wave.started"))
      source.publish(runEvent("dag_1", 3, "dag.node.transitioned"))

      // then
      const events = emittedNames(emitted, "omo.dag.event")
      expect(events.map((entry) => (entry.data as DagBridgeRunEvent).seq)).toEqual([1, 2, 3])
      expect(events.map((entry) => (entry.data as DagBridgeRunEvent).type)).toEqual([
        "dag.run.created",
        "dag.wave.started",
        "dag.node.transitioned",
      ])
    })

    it("#when a run starts mid-session and sync runs #then its events reach the ledger too", () => {
      // given
      const first = fakeRun("dag_1", "running")
      const { bridge, emitted, addRun } = wire([first.run])
      bridge.attach()
      const late = fakeRun("dag_2", "running")
      addRun(late.run)

      // when
      bridge.sync()
      late.publish(runEvent("dag_2", 1, "dag.run.created"))

      // then
      const events = emittedNames(emitted, "omo.dag.event").map((entry) => entry.data as DagBridgeRunEvent)
      expect(events.map((event) => event.runId)).toEqual(["dag_2"])
    })

    it("#when the same seq is redelivered #then it is emitted once", () => {
      // given
      const source = fakeRun("dag_1", "running")
      const { bridge, emitted } = wire([source.run])
      bridge.attach()

      // when
      source.publish(runEvent("dag_1", 1, "dag.run.created"))
      source.publish(runEvent("dag_1", 1, "dag.run.created"))

      // then
      expect(emittedNames(emitted, "omo.dag.event")).toHaveLength(1)
    })
  })

  describe("#given a session that owns a live run", () => {
    it("#when the heartbeat interval elapses #then omo.dag.heartbeat carries every live run head seq", () => {
      // given
      const source = fakeRun("dag_1", "running")
      const { bridge, emitted, timers } = wire([source.run])
      bridge.attach()
      source.publish(runEvent("dag_1", 4, "dag.wave.started"))

      // when
      timers.advance(DAG_DEFAULT_HEARTBEAT_MS)

      // then
      const beats = emittedNames(emitted, "omo.dag.heartbeat")
      expect(beats).toHaveLength(1)
      expect(beats[0]?.data).toEqual({
        schemaVersion: 1,
        at: new Date(DAG_DEFAULT_HEARTBEAT_MS).toISOString(),
        runs: [{ runId: "dag_1", headSeq: 4 }],
      })
    })

    it("#when the run reaches a terminal status #then the heartbeat stops and no timer is left pending", () => {
      // given
      const source = fakeRun("dag_1", "running")
      const { bridge, emitted, timers } = wire([source.run])
      bridge.attach()
      timers.advance(DAG_DEFAULT_HEARTBEAT_MS)
      expect(emittedNames(emitted, "omo.dag.heartbeat")).toHaveLength(1)

      // when
      source.setStatus("completed")
      timers.advance(DAG_DEFAULT_HEARTBEAT_MS * 3)

      // then
      expect(emittedNames(emitted, "omo.dag.heartbeat")).toHaveLength(1)
      expect(timers.pending()).toBe(0)
    })

    it("#when only terminal runs exist at attach #then no heartbeat is ever emitted", () => {
      // given
      const source = fakeRun("dag_1", "failed")
      const { bridge, emitted, timers } = wire([source.run])

      // when
      bridge.attach()
      timers.advance(DAG_DEFAULT_HEARTBEAT_MS * 2)

      // then
      expect(emittedNames(emitted, "omo.dag.heartbeat")).toHaveLength(0)
      expect(timers.pending()).toBe(0)
    })

    it("#when the session shuts down mid-run #then the heartbeat timer is cleared", () => {
      // given
      const source = fakeRun("dag_1", "running")
      const { bridge, emitted, timers } = wire([source.run])
      bridge.attach()
      expect(timers.pending()).toBeGreaterThan(0)

      // when
      bridge.dispose()
      timers.advance(DAG_DEFAULT_HEARTBEAT_MS * 2)

      // then
      expect(timers.pending()).toBe(0)
      expect(emittedNames(emitted, "omo.dag.heartbeat")).toHaveLength(0)
    })

    it("#when a session switch detaches the bridge #then no further run events are emitted", () => {
      // given
      const source = fakeRun("dag_1", "running")
      const { bridge, emitted, timers } = wire([source.run])
      bridge.attach()
      source.publish(runEvent("dag_1", 1, "dag.run.created"))

      // when
      bridge.detach()
      source.publish(runEvent("dag_1", 2, "dag.wave.started"))
      timers.advance(DAG_DEFAULT_HEARTBEAT_MS * 2)

      // then
      expect(emittedNames(emitted, "omo.dag.event")).toHaveLength(1)
      expect(emittedNames(emitted, "omo.dag.heartbeat")).toHaveLength(0)
      expect(timers.pending()).toBe(0)
    })
  })

  describe("#given unsequenced activity telemetry", () => {
    it("#when a node bursts activity #then it coalesces to the latest payload on omo.dag.activity only", () => {
      // given
      const source = fakeRun("dag_1", "running")
      const { bridge, emitted, timers } = wire([source.run])
      bridge.attach()

      // when
      bridge.publishActivity(activityEvent("dag_1", "node_a", "reading"))
      bridge.publishActivity(activityEvent("dag_1", "node_a", "editing"))
      bridge.publishActivity(activityEvent("dag_1", "node_a", "running tests"))
      timers.advance(DAG_ACTIVITY_COALESCE_MS)

      // then
      const activity = emittedNames(emitted, "omo.dag.activity")
      expect(activity).toHaveLength(1)
      expect((activity[0]?.data as DagBridgeActivityEvent).activity).toBe("running tests")
      expect(emittedNames(emitted, "omo.dag.event")).toHaveLength(0)
    })

    it("#when two nodes are active #then coalescing is per node", () => {
      // given
      const source = fakeRun("dag_1", "running")
      const { bridge, emitted, timers } = wire([source.run])
      bridge.attach()

      // when
      bridge.publishActivity(activityEvent("dag_1", "node_a", "a1"))
      bridge.publishActivity(activityEvent("dag_1", "node_b", "b1"))
      bridge.publishActivity(activityEvent("dag_1", "node_a", "a2"))
      timers.advance(DAG_ACTIVITY_COALESCE_MS)

      // then
      const activity = emittedNames(emitted, "omo.dag.activity").map(
        (entry) => (entry.data as DagBridgeActivityEvent),
      )
      expect(activity.map((event) => [event.nodeId, event.activity])).toEqual([
        ["node_a", "a2"],
        ["node_b", "b1"],
      ])
    })

    it("#when activity is published after detach #then nothing is emitted and no timer survives", () => {
      // given
      const source = fakeRun("dag_1", "running")
      const { bridge, emitted, timers } = wire([source.run])
      bridge.attach()
      bridge.publishActivity(activityEvent("dag_1", "node_a", "reading"))

      // when
      bridge.detach()
      bridge.publishActivity(activityEvent("dag_1", "node_a", "editing"))
      timers.advance(DAG_ACTIVITY_COALESCE_MS * 4)

      // then
      expect(emittedNames(emitted, "omo.dag.activity")).toHaveLength(0)
      expect(timers.pending()).toBe(0)
    })
  })

  describe("#given a configured heartbeat interval", () => {
    it("#when task.dag.heartbeat_ms overrides the default #then beats follow the configured period", () => {
      // given
      const source = fakeRun("dag_1", "running")
      const { bridge, emitted, timers } = wire([source.run], { heartbeatMs: 5000 })
      bridge.attach()

      // when
      timers.advance(5000 * 2)

      // then
      expect(emittedNames(emitted, "omo.dag.heartbeat")).toHaveLength(2)
    })
  })
})
