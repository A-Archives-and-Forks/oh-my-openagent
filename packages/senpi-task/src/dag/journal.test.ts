// allow: SIZE_OK - the journal acceptance matrix keeps durability, replay, and subscriber backpressure invariants together.
import { afterEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { dagRunStartedEvent } from "./events"
import { createDagJournal, type DagJournalCheckpoint } from "./journal"
import { createDagFileStore, type DagFileStore } from "./store"
import type { DagRunEvent, DagRunId } from "./types"

const cleanupRoots: string[] = []
const runId = "run-journal" as DagRunId

interface TestCheckpoint extends DagJournalCheckpoint {
  readonly runId: DagRunId
  readonly generations: readonly number[]
}

afterEach(() => {
  for (const root of cleanupRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function tempProject(): string {
  const directory = fs.mkdtempSync(join(tmpdir(), "senpi-dag-journal-"))
  cleanupRoots.push(directory)
  return directory
}

function initialCheckpoint(): TestCheckpoint {
  return { schemaVersion: 1, runId, checkpointSeq: 0, generations: [] }
}

function applyEvent(checkpoint: TestCheckpoint, event: DagRunEvent): TestCheckpoint {
  return event.type === "dag.run.started"
    ? { ...checkpoint, generations: [...checkpoint.generations, event.generation] }
    : checkpoint
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve = (): void => undefined
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function nextMicrotask(): Promise<void> {
  await new Promise<void>((resolve) => queueMicrotask(resolve))
}

describe("createDagJournal WAL ordering and replay", () => {
  test("#given three mutations #when appended #then subscribers see durable events in order and checkpoint seq reaches three", async () => {
    // given
    const store = createDagFileStore({ project_dir: tempProject() })
    const journal = createDagJournal({ store, runId, initialCheckpoint: initialCheckpoint(), applyEvent })
    const delivered: number[] = []
    const durableAtDelivery: number[] = []
    journal.subscribe((event) => {
      delivered.push(event.seq)
      durableAtDelivery.push(store.readCheckpoint<TestCheckpoint>(runId)?.checkpointSeq ?? -1)
    })

    // when
    journal.append(dagRunStartedEvent({ generation: 1 }))
    journal.append(dagRunStartedEvent({ generation: 2 }))
    journal.append(dagRunStartedEvent({ generation: 3 }))
    await journal.whenIdle()

    // then
    expect(delivered).toEqual([1, 2, 3])
    expect(durableAtDelivery).toEqual([3, 3, 3])
    expect(store.readCheckpoint<TestCheckpoint>(runId)).toEqual({
      schemaVersion: 1,
      runId,
      checkpointSeq: 3,
      generations: [1, 2, 3],
    })
  })

  test("#given checkpoint replacement crashes after WAL append #when reopened #then the orphan is replayed exactly once without premature delivery", async () => {
    // given
    const project = tempProject()
    const durableStore = createDagFileStore({ project_dir: project })
    let failOnce = true
    const crashingStore: DagFileStore = {
      ...durableStore,
      writeCheckpoint(id, checkpoint) {
        if (failOnce) {
          failOnce = false
          throw new Error("injected checkpoint crash")
        }
        durableStore.writeCheckpoint(id, checkpoint)
      },
    }
    const crashing = createDagJournal({
      store: crashingStore,
      runId,
      initialCheckpoint: initialCheckpoint(),
      applyEvent,
    })
    const deliveredBeforeDurability: DagRunEvent[] = []
    crashing.subscribe((event) => {
      deliveredBeforeDurability.push(event)
    })

    // when
    expect(() => crashing.append(dagRunStartedEvent({ generation: 1 }))).toThrow("injected checkpoint crash")
    await nextMicrotask()
    const reopenedStore = createDagFileStore({ project_dir: project })
    const reopened = createDagJournal({
      store: reopenedStore,
      runId,
      initialCheckpoint: initialCheckpoint(),
      applyEvent,
    })
    const deliveredAfterReopen: number[] = []
    reopened.subscribe((event) => {
      deliveredAfterReopen.push(event.seq)
    })
    const second = reopened.append(dagRunStartedEvent({ generation: 2 }))
    await nextMicrotask()

    // then
    expect(deliveredBeforeDurability).toEqual([])
    expect(second.seq).toBe(2)
    expect(deliveredAfterReopen).toEqual([2])
    expect(reopened.snapshot()).toEqual({
      schemaVersion: 1,
      runId,
      checkpointSeq: 2,
      generations: [1, 2],
    })
    expect(reopenedStore.readEvents(runId, 0, { limit: 10 }).events.map((event) => event.seq)).toEqual([1, 2])
  })

  test("#given a durable checkpoint and WAL #when reopened #then sequence numbers continue from the greater persisted tail", () => {
    // given
    const project = tempProject()
    const firstStore = createDagFileStore({ project_dir: project })
    const first = createDagJournal({ store: firstStore, runId, initialCheckpoint: initialCheckpoint(), applyEvent })
    first.append(dagRunStartedEvent({ generation: 1 }))
    first.append(dagRunStartedEvent({ generation: 2 }))

    // when
    const reopenedStore = createDagFileStore({ project_dir: project })
    const reopened = createDagJournal({
      store: reopenedStore,
      runId,
      initialCheckpoint: initialCheckpoint(),
      applyEvent,
    })
    const event = reopened.append(dagRunStartedEvent({ generation: 3 }))

    // then
    expect(event.seq).toBe(3)
    expect(reopened.snapshot().checkpointSeq).toBe(3)
  })
})

describe("createDagJournal subscribers", () => {
  test("#given a subscriber blocked on its first event #when its ring overflows #then it receives one coalesced overflow with the last delivered recovery seq", async () => {
    // given
    const store = createDagFileStore({ project_dir: tempProject() })
    const journal = createDagJournal({
      store,
      runId,
      initialCheckpoint: initialCheckpoint(),
      applyEvent,
      subscriberRing: 2,
    })
    const releaseFirst = deferred()
    const firstStarted = deferred()
    const delivered: DagRunEvent[] = []
    journal.subscribe(async (event) => {
      delivered.push(event)
      if (event.seq === 1 && event.type === "dag.run.started") {
        firstStarted.resolve()
        await releaseFirst.promise
      }
    })
    journal.append(dagRunStartedEvent({ generation: 1 }))
    await firstStarted.promise

    // when
    journal.append(dagRunStartedEvent({ generation: 2 }))
    journal.append(dagRunStartedEvent({ generation: 3 }))
    journal.append(dagRunStartedEvent({ generation: 4 }))
    journal.append(dagRunStartedEvent({ generation: 5 }))
    releaseFirst.resolve()
    await journal.whenIdle()

    // then
    expect(delivered.map((event) => event.type)).toEqual([
      "dag.run.started",
      "dag.stream.overflow",
      "dag.run.started",
      "dag.run.started",
    ])
    expect(delivered[1]).toMatchObject({
      type: "dag.stream.overflow",
      dropped: 2,
      oldestDroppedSeq: 1,
    })
    expect(delivered.slice(2).map((event) => event.seq)).toEqual([4, 5])
  })

  test("#given a slow async listener #when another mutation is appended #then the mutation completes before the listener catches up", async () => {
    // given
    const store = createDagFileStore({ project_dir: tempProject() })
    const journal = createDagJournal({ store, runId, initialCheckpoint: initialCheckpoint(), applyEvent })
    const release = deferred()
    const listenerStarted = deferred()
    journal.subscribe(async () => {
      listenerStarted.resolve()
      await release.promise
    })
    journal.append(dagRunStartedEvent({ generation: 1 }))
    await listenerStarted.promise

    // when
    const second = journal.append(dagRunStartedEvent({ generation: 2 }))

    // then
    expect(second.seq).toBe(2)
    expect(journal.snapshot().checkpointSeq).toBe(2)
    release.resolve()
    await journal.whenIdle()
  })

  test("#given an active subscription #when it is removed #then later events are not delivered", async () => {
    // given
    const store = createDagFileStore({ project_dir: tempProject() })
    const journal = createDagJournal({ store, runId, initialCheckpoint: initialCheckpoint(), applyEvent })
    const delivered: number[] = []
    const unsubscribe = journal.subscribe((event) => {
      delivered.push(event.seq)
    })
    journal.append(dagRunStartedEvent({ generation: 1 }))
    await journal.whenIdle()

    // when
    unsubscribe()
    journal.append(dagRunStartedEvent({ generation: 2 }))
    await nextMicrotask()

    // then
    expect(delivered).toEqual([1])
  })
})
