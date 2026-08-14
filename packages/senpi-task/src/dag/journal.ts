import { dagEventLane } from "./events"
import type { DagFileStore } from "./store"
import {
  DAG_SETTINGS_DEFAULTS,
  type DagRunEvent,
  type DagRunEventPayload,
  type DagRunId,
} from "./types"

const REPLAY_PAGE_SIZE = 1000

export interface DagJournalCheckpoint {
  readonly schemaVersion: 1
  readonly checkpointSeq: number
}

export type DagJournalListener = (event: DagRunEvent) => void | Promise<void>

export type DagJournalOptions<TCheckpoint extends DagJournalCheckpoint> = {
  readonly store: DagFileStore
  readonly runId: DagRunId
  readonly initialCheckpoint: TCheckpoint
  readonly applyEvent: (checkpoint: TCheckpoint, event: DagRunEvent) => TCheckpoint
  readonly subscriberRing?: number
  readonly now?: () => number
}

export type DagJournal<TCheckpoint extends DagJournalCheckpoint> = {
  readonly append: (payload: DagRunEventPayload) => DagRunEvent
  readonly snapshot: () => TCheckpoint
  readonly subscribe: (listener: DagJournalListener) => () => void
  readonly whenIdle: () => Promise<void>
}

type OverflowState = {
  dropped: number
  firstDroppedSeq: number
  recoverAfterSeq: number
}

type Subscriber = {
  readonly listener: DagJournalListener
  readonly queue: DagRunEvent[]
  active: boolean
  running: boolean
  lastDeliveredSeq: number
  overflow?: OverflowState
  drainPromise: Promise<void>
}

export function createDagJournal<TCheckpoint extends DagJournalCheckpoint>(
  options: DagJournalOptions<TCheckpoint>,
): DagJournal<TCheckpoint> {
  const ringSize = options.subscriberRing ?? DAG_SETTINGS_DEFAULTS.subscriber_ring
  if (!Number.isInteger(ringSize) || ringSize <= 0) {
    throw new Error("subscriber ring must be a positive integer")
  }
  const now = options.now ?? Date.now
  const subscribers = new Set<Subscriber>()
  let checkpoint = options.store.withRunLock(options.runId, () => recoverCheckpoint(options))

  return {
    append(payload) {
      let durableEvent: DagRunEvent | undefined
      checkpoint = options.store.withRunLock(options.runId, () => {
        const recovered = recoverCheckpoint(options)
        const tailSeq = eventLogTailSeq(options.store, options.runId, recovered.checkpointSeq)
        const seq = Math.max(recovered.checkpointSeq, tailSeq) + 1
        const event: DagRunEvent = {
          ...payload,
          schemaVersion: 1,
          runId: options.runId,
          seq,
          at: new Date(now()).toISOString(),
          lane: dagEventLane(payload.type),
        }
        options.store.appendEvent(event)
        const applied = options.applyEvent(recovered, event)
        const next = { ...applied, schemaVersion: 1, checkpointSeq: seq }
        options.store.writeCheckpoint(options.runId, next)
        durableEvent = event
        return next
      })
      const event = durableEvent
      if (event === undefined) throw new Error("DAG journal mutation completed without an event")
      for (const subscriber of subscribers) enqueue(subscriber, event, ringSize, options.runId, now)
      return event
    },
    snapshot: () => checkpoint,
    subscribe(listener) {
      const subscriber: Subscriber = {
        listener,
        queue: [],
        active: true,
        running: false,
        lastDeliveredSeq: checkpoint.checkpointSeq,
        drainPromise: Promise.resolve(),
      }
      subscribers.add(subscriber)
      return () => {
        subscriber.active = false
        subscriber.queue.length = 0
        subscriber.overflow = undefined
        subscribers.delete(subscriber)
      }
    },
    whenIdle: async () => {
      await Promise.all([...subscribers].map((subscriber) => subscriber.drainPromise))
    },
  }
}

function recoverCheckpoint<TCheckpoint extends DagJournalCheckpoint>(
  options: DagJournalOptions<TCheckpoint>,
): TCheckpoint {
  let checkpoint = options.store.readCheckpoint<TCheckpoint>(options.runId) ?? options.initialCheckpoint
  let sinceSeq = checkpoint.checkpointSeq
  let replayed = false
  for (;;) {
    const page = options.store.readEvents(options.runId, sinceSeq, { limit: REPLAY_PAGE_SIZE })
    for (const event of page.events) {
      const applied = options.applyEvent(checkpoint, event)
      checkpoint = { ...applied, schemaVersion: 1, checkpointSeq: event.seq }
      replayed = true
    }
    if (!page.hasMore) break
    sinceSeq = page.nextSinceSeq
  }
  if (replayed) options.store.writeCheckpoint(options.runId, checkpoint)
  return checkpoint
}

function eventLogTailSeq(store: DagFileStore, runId: DagRunId, sinceSeq: number): number {
  return store.readEvents(runId, sinceSeq, { limit: 1 }).headSeq
}

function enqueue(
  subscriber: Subscriber,
  event: DagRunEvent,
  ringSize: number,
  runId: DagRunId,
  now: () => number,
): void {
  if (!subscriber.active) return
  if (subscriber.queue.length >= ringSize) {
    const dropped = subscriber.queue.shift()
    if (dropped !== undefined) {
      if (subscriber.overflow === undefined) {
        subscriber.overflow = {
          dropped: 1,
          firstDroppedSeq: dropped.seq,
          recoverAfterSeq: subscriber.lastDeliveredSeq,
        }
      } else {
        subscriber.overflow.dropped += 1
      }
    }
  }
  subscriber.queue.push(event)
  if (!subscriber.running) scheduleDrain(subscriber, runId, now)
}

function scheduleDrain(subscriber: Subscriber, runId: DagRunId, now: () => number): void {
  subscriber.running = true
  subscriber.drainPromise = new Promise<void>((resolve) => {
    queueMicrotask(() => {
      void drain(subscriber, runId, now).finally(resolve)
    })
  })
}

async function drain(subscriber: Subscriber, runId: DagRunId, now: () => number): Promise<void> {
  try {
    while (subscriber.active) {
      const overflow = subscriber.overflow
      if (overflow !== undefined) {
        subscriber.overflow = undefined
        await deliver(subscriber.listener, overflowEvent(runId, overflow, now))
        continue
      }
      const event = subscriber.queue.shift()
      if (event === undefined) break
      subscriber.lastDeliveredSeq = event.seq
      await deliver(subscriber.listener, event)
    }
  } finally {
    subscriber.running = false
    if (subscriber.active && (subscriber.overflow !== undefined || subscriber.queue.length > 0)) {
      scheduleDrain(subscriber, runId, now)
    }
  }
}

async function deliver(listener: DagJournalListener, event: DagRunEvent): Promise<void> {
  try {
    await listener(event)
  } catch (error) {
    console.error("DAG journal subscriber failed", error)
  }
}

function overflowEvent(runId: DagRunId, overflow: OverflowState, now: () => number): DagRunEvent {
  return {
    schemaVersion: 1,
    runId,
    seq: overflow.firstDroppedSeq,
    at: new Date(now()).toISOString(),
    lane: "boundary",
    type: "dag.stream.overflow",
    dropped: overflow.dropped,
    oldestDroppedSeq: overflow.recoverAfterSeq,
  }
}
