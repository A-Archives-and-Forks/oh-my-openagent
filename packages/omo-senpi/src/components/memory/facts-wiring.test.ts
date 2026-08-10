import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  TranscriptJournal,
  buildIdentityPaths,
  type MemoryIdentityPaths,
  type TranscriptEntry,
} from "@oh-my-opencode/memory-core"

import { createMemoryFactsWiring } from "./facts-wiring"

const IDENTITY = "facts-wiring-agent"
const SESSION = "session-alpha"
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function fixture(): Promise<MemoryIdentityPaths> {
  const dir = await mkdtemp(join(tmpdir(), "omo-memory-facts-wiring-"))
  tempDirs.push(dir)
  const paths = buildIdentityPaths(join(dir, "memory"), IDENTITY)
  await mkdir(paths.locks, { recursive: true })
  await mkdir(paths.factsQueue, { recursive: true })
  return paths
}

function entry(kind: "user" | "assistant", messageId: string): TranscriptEntry {
  return {
    kind,
    text: `${kind} ${messageId}`,
    captured_at: "2026-01-01T00:00:00.000Z",
    source_line_id: `${messageId}:${kind}`,
    source_message_id: messageId,
  }
}

/** Seeds the real journal so the wiring reads entries through TranscriptJournal. */
async function seedJournal(paths: MemoryIdentityPaths, count: number): Promise<void> {
  const journal = new TranscriptJournal({ journalDir: join(paths.transcripts, SESSION) })
  const entries: TranscriptEntry[] = []
  for (let index = 1; index <= count; index += 1) {
    entries.push(entry("user", `m${index}`), entry("assistant", `m${index}`))
  }
  await journal.append(entries)
}

async function queueFileCount(paths: MemoryIdentityPaths): Promise<number> {
  const names = await readdir(paths.factsQueue).catch(() => [] as string[])
  return names.filter((name) => name.endsWith(".json") && name !== "consumed.json").length
}

function wiringFor(paths: MemoryIdentityPaths, enabled: boolean) {
  return createMemoryFactsWiring({
    identity: IDENTITY,
    identityPaths: paths,
    factsEnabled: () => enabled,
  })
}

describe("facts wiring settle enqueue", () => {
  test("#given debounce four #when four settles complete #then exactly one all-pending extractor launch fires", async () => {
    // given
    const paths = await fixture()
    await seedJournal(paths, 2)
    let launches = 0
    let signalLaunch: (() => void) | undefined
    const launched = new Promise<void>((resolve) => { signalLaunch = resolve })
    const wiring = createMemoryFactsWiring({
      identity: IDENTITY,
      identityPaths: paths,
      factsEnabled: () => true,
      debounceSettles: () => 4,
      extractor: {
        launchPending: async () => {
          launches += 1
          signalLaunch?.()
        },
        reconcilePending: async () => undefined,
      },
    })

    // when
    await wiring.onSettled(SESSION)
    await wiring.onSettled(SESSION)
    await wiring.onSettled(SESSION)
    expect(launches).toBe(0)
    await wiring.onSettled(SESSION)
    await Promise.race([
      launched,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("facts launch did not fire")), 2_000)),
    ])

    // then
    expect(launches).toBe(1)
    expect(await queueFileCount(paths)).toBe(1)
  })

  test("#given facts enabled and a new journal delta #when settle runs #then one queue file is published", async () => {
    // given
    const paths = await fixture()
    await seedJournal(paths, 2)
    const wiring = wiringFor(paths, true)

    // when
    const result = await wiring.enqueueSettled(SESSION)

    // then
    expect(result.enqueued).toBe(true)
    expect(await queueFileCount(paths)).toBe(1)
  })

  test("#given the same cursor #when settle runs twice #then no duplicate entry is published", async () => {
    // given
    const paths = await fixture()
    await seedJournal(paths, 2)
    const wiring = wiringFor(paths, true)
    await wiring.enqueueSettled(SESSION)

    // when
    const duplicate = await wiring.enqueueSettled(SESSION)

    // then
    expect(duplicate.enqueued).toBe(false)
    expect(await queueFileCount(paths)).toBe(1)
  })

  test("#given facts disabled #when settle runs #then nothing is enqueued", async () => {
    // given
    const paths = await fixture()
    await seedJournal(paths, 2)
    const wiring = wiringFor(paths, false)

    // when
    const result = await wiring.enqueueSettled(SESSION)

    // then
    expect(result.enqueued).toBe(false)
    expect(await queueFileCount(paths)).toBe(0)
  })

  test("#given an empty journal #when settle runs #then nothing is enqueued", async () => {
    // given
    const paths = await fixture()
    const wiring = wiringFor(paths, true)

    // when
    const result = await wiring.enqueueSettled(SESSION)

    // then
    expect(result.enqueued).toBe(false)
    expect(await queueFileCount(paths)).toBe(0)
  })
})

describe("facts wiring session_start reconcile", () => {
  test("#given a leftover queue file from a crashed run #when reconcile runs #then it is reported launchable", async () => {
    // given: a settle published an entry that no extractor ever consumed
    const paths = await fixture()
    await seedJournal(paths, 2)
    await wiringFor(paths, true).enqueueSettled(SESSION)

    // when: a fresh session starts and reconciles the durable queue
    const recovered = wiringFor(paths, true)
    const launchable = await recovered.reconcilePending()

    // then
    expect(launchable).toHaveLength(1)
    expect(launchable[0]?.conversationId).toBe(SESSION)
    expect(launchable[0]?.range.end_message_id).toBe("m2")
  })

  test("#given facts disabled #when reconcile runs #then no leftover work is reported", async () => {
    // given
    const paths = await fixture()
    await seedJournal(paths, 2)
    await wiringFor(paths, true).enqueueSettled(SESSION)

    // when
    const launchable = await wiringFor(paths, false).reconcilePending()

    // then
    expect(launchable).toHaveLength(0)
  })

  test("#given a consumed batch #when reconcile runs #then nothing is left to relaunch", async () => {
    // given
    const paths = await fixture()
    await seedJournal(paths, 2)
    const wiring = wiringFor(paths, true)
    await wiring.enqueueSettled(SESSION)

    // when
    await wiring.markConsumed(await wiring.reconcilePending())

    // then
    expect(await wiring.reconcilePending()).toHaveLength(0)
    expect(await queueFileCount(paths)).toBe(0)
  })
})
