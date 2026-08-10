import { describe, expect, test, afterEach } from "bun:test"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { buildIdentityPaths, type MemoryIdentityPaths } from "../identity"
import type { TranscriptEntry } from "../journal"
import {
  FactsQueue,
  factsQueuePaths,
  type FactsEnqueueRequest,
} from "./queue"

const IDENTITY = "facts-queue-agent"
const CONVERSATION = "conversation-alpha"
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function identityFixture(): Promise<MemoryIdentityPaths> {
  const dir = await mkdtemp(join(tmpdir(), "memory-facts-queue-"))
  tempDirs.push(dir)
  return buildIdentityPaths(join(dir, "memory"), IDENTITY)
}

function entry(kind: "user" | "assistant", messageId: string, text: string): TranscriptEntry {
  return {
    kind,
    text,
    captured_at: "2026-01-01T00:00:00.000Z",
    source_line_id: `${messageId}:${kind}`,
    source_message_id: messageId,
  }
}

/** Canonical journal: user/assistant pairs m1..mN in positional order. */
function journal(count: number): TranscriptEntry[] {
  const entries: TranscriptEntry[] = []
  for (let index = 1; index <= count; index += 1) {
    entries.push(entry("user", `m${index}`, `ask ${index}`))
    entries.push(entry("assistant", `m${index}`, `answer ${index}`))
  }
  return entries
}

function request(
  entries: readonly TranscriptEntry[],
  overrides: Partial<FactsEnqueueRequest> = {},
): FactsEnqueueRequest {
  return {
    identity: IDENTITY,
    sessionId: "session-1",
    conversationId: CONVERSATION,
    entries,
    ...overrides,
  }
}

function clockFrom(start: number): () => Date {
  let tick = start
  return () => new Date((tick += 1000))
}

async function queueFileNames(paths: MemoryIdentityPaths): Promise<string[]> {
  const names = await readdir(paths.factsQueue).catch(() => [] as string[])
  return names.filter((name) => name.endsWith(".json") && name !== "consumed.json").sort()
}

describe("facts queue enqueue", () => {
  test("#given a fresh journal delta #when enqueue runs #then one queue file holds the full canonical range", async () => {
    // given
    const paths = await identityFixture()
    const queue = new FactsQueue({ identityPaths: paths, now: clockFrom(0) })
    const entries = journal(2)

    // when
    const result = await queue.enqueue(request(entries))

    // then
    expect(result.enqueued).toBe(true)
    const names = await queueFileNames(paths)
    expect(names).toHaveLength(1)
    const pending = await queue.listPending()
    expect(pending).toHaveLength(1)
    expect(pending[0]?.version).toBe(1)
    expect(pending[0]?.conversationId).toBe(CONVERSATION)
    expect(pending[0]?.range.start_message_id).toBe("m1")
    expect(pending[0]?.range.end_message_id).toBe("m2")
    expect(pending[0]?.range.end_snapshot_line).toBe(entries.length)
    expect(pending[0]?.entries.map((row) => row.source_message_id)).toEqual([
      "m1",
      "m1",
      "m2",
      "m2",
    ])
  })

  test("#given an identical settle #when enqueue runs again #then the duplicate endpoint is skipped", async () => {
    // given
    const paths = await identityFixture()
    const queue = new FactsQueue({ identityPaths: paths, now: clockFrom(0) })
    const entries = journal(2)
    await queue.enqueue(request(entries))

    // when
    const duplicate = await queue.enqueue(request(entries))

    // then
    expect(duplicate.enqueued).toBe(false)
    if (duplicate.enqueued) throw new Error("expected the duplicate settle to be skipped")
    expect(duplicate.reason).toBe("no-new-entries")
    expect(await queueFileNames(paths)).toHaveLength(1)
  })

  test("#given a retained entry ending at m2 #when a later settle arrives #then the new range starts strictly after it", async () => {
    // given
    const paths = await identityFixture()
    const queue = new FactsQueue({ identityPaths: paths, now: clockFrom(0) })
    await queue.enqueue(request(journal(2)))

    // when
    const second = await queue.enqueue(request(journal(4)))

    // then
    expect(second.enqueued).toBe(true)
    const pending = await queue.listPending()
    expect(pending).toHaveLength(2)
    const ranges = pending.map((item) => [item.range.start_message_id, item.range.end_message_id])
    expect(ranges).toEqual([
      ["m1", "m2"],
      ["m3", "m4"],
    ])
  })

  test("#given the consumed watermark already covers the endpoint #when enqueue runs #then nothing is published", async () => {
    // given
    const paths = await identityFixture()
    const queue = new FactsQueue({ identityPaths: paths, now: clockFrom(0) })
    const entries = journal(2)
    await queue.enqueue(request(entries))
    const pending = await queue.listPending()
    await queue.markConsumed(pending)

    // when
    const again = await queue.enqueue(request(entries))

    // then
    expect(again.enqueued).toBe(false)
    expect(await queueFileNames(paths)).toHaveLength(0)
    expect(await queue.listPending()).toHaveLength(0)
  })

  test("#given only non-canonical trailing entries #when enqueue runs #then no queue file is published", async () => {
    // given
    const paths = await identityFixture()
    const queue = new FactsQueue({ identityPaths: paths, now: clockFrom(0) })
    const entries: TranscriptEntry[] = [
      {
        kind: "tool_call",
        name: "read",
        captured_at: "2026-01-01T00:00:00.000Z",
        source_line_id: "m1:tool:call-1",
        source_message_id: "m1",
      },
    ]

    // when
    const result = await queue.enqueue(request(entries))

    // then
    expect(result.enqueued).toBe(false)
    expect(await queueFileNames(paths)).toHaveLength(0)
  })
})

describe("facts queue file naming", () => {
  test("#given a published entry #when the filename is inspected #then it is colon-free and hashes the conversation id", async () => {
    // given
    const paths = await identityFixture()
    const queue = new FactsQueue({ identityPaths: paths, now: clockFrom(0) })

    // when
    await queue.enqueue(request(journal(1)))

    // then
    const [name = ""] = await queueFileNames(paths)
    expect(name).not.toContain(":")
    expect(name).not.toContain(CONVERSATION)
    expect(name).toMatch(/^\d{8}T\d{6}\d{3}Z-[a-f0-9]{12}-[a-f0-9]{8}\.json$/)
  })

  test("#given two publications in the same millisecond #when both land #then the endpoint hash keeps them distinct", async () => {
    // given
    const paths = await identityFixture()
    const frozen = (): Date => new Date(0)
    const queue = new FactsQueue({ identityPaths: paths, now: frozen })

    // when
    await queue.enqueue(request(journal(1)))
    await queue.enqueue(request(journal(2)))

    // then
    expect(await queueFileNames(paths)).toHaveLength(2)
  })
})

describe("facts queue concurrency", () => {
  test("#given two concurrent enqueue attempts for the same delta #when both run #then exactly one entry is published", async () => {
    // given
    const paths = await identityFixture()
    const entries = journal(2)
    const first = new FactsQueue({ identityPaths: paths, now: clockFrom(0) })
    const second = new FactsQueue({ identityPaths: paths, now: clockFrom(50_000) })

    // when
    const results = await Promise.all([
      first.enqueue(request(entries)),
      second.enqueue(request(entries)),
    ])

    // then
    expect(results.filter((result) => result.enqueued)).toHaveLength(1)
    expect(await queueFileNames(paths)).toHaveLength(1)
  })
})

describe("facts queue watermark monotonicity", () => {
  test("#given an older batch settling after a newer one was queued #when it is consumed #then the enqueue watermark never rolls back", async () => {
    // given: batch A (through m2) is queued, then batch B (through m4) is queued
    const paths = await identityFixture()
    const queue = new FactsQueue({ identityPaths: paths, now: clockFrom(0) })
    await queue.enqueue(request(journal(2)))
    await queue.enqueue(request(journal(4)))
    const pending = await queue.listPending()
    const olderBatch = pending.filter((item) => item.range.end_message_id === "m2")
    const newerBatch = pending.filter((item) => item.range.end_message_id === "m4")
    expect(olderBatch).toHaveLength(1)
    expect(newerBatch).toHaveLength(1)

    // when: the NEWER batch finishes first, then the OLDER batch finishes late
    await queue.markConsumed(newerBatch)
    const afterNewer = await queue.readCursor(CONVERSATION)
    await queue.markConsumed(olderBatch)
    const afterOlder = await queue.readCursor(CONVERSATION)

    // then: the enqueue watermark stays at the greatest durably queued endpoint
    expect(afterNewer.enqueued_through_message_id).toBe("m4")
    expect(afterOlder.enqueued_through_message_id).toBe("m4")
    // and the late older batch never drags the consumed watermark backward either
    expect(afterNewer.consumed_through_message_id).toBe("m4")
    expect(afterOlder.consumed_through_message_id).toBe("m4")
  })

  test("#given a late older batch consumed #when the next settle runs #then no range overlapping the retained newer entry is republished", async () => {
    // given
    const paths = await identityFixture()
    const queue = new FactsQueue({ identityPaths: paths, now: clockFrom(0) })
    await queue.enqueue(request(journal(2)))
    await queue.enqueue(request(journal(4)))
    const pending = await queue.listPending()
    await queue.markConsumed(pending.filter((item) => item.range.end_message_id === "m4"))
    await queue.markConsumed(pending.filter((item) => item.range.end_message_id === "m2"))

    // when
    const next = await queue.enqueue(request(journal(6)))

    // then
    expect(next.enqueued).toBe(true)
    const republished = (await queue.listPending()).map((item) => [
      item.range.start_message_id,
      item.range.end_message_id,
    ])
    expect(republished).toEqual([["m5", "m6"]])
  })

  test("#given a failed batch #when it is retained #then the enqueue watermark does not roll back and the entry survives", async () => {
    // given
    const paths = await identityFixture()
    const queue = new FactsQueue({ identityPaths: paths, now: clockFrom(0) })
    await queue.enqueue(request(journal(2)))
    const before = await queue.readCursor(CONVERSATION)

    // when: the extractor fails, so nothing is marked consumed
    const after = await queue.readCursor(CONVERSATION)

    // then
    expect(before.enqueued_through_message_id).toBe("m2")
    expect(after.enqueued_through_message_id).toBe("m2")
    expect(after.consumed_through_message_id).toBe(null)
    expect(await queue.listPending()).toHaveLength(1)
  })

  test("#given a queue file that landed without its cursor write #when the next settle runs #then the retained endpoint anchors the range", async () => {
    // given: simulate the crash window by deleting the cursor file only
    const paths = await identityFixture()
    const queue = new FactsQueue({ identityPaths: paths, now: clockFrom(0) })
    await queue.enqueue(request(journal(2)))
    await rm(factsQueuePaths(paths).cursorPath(CONVERSATION), { force: true })

    // when
    const next = await queue.enqueue(request(journal(4)))

    // then
    expect(next.enqueued).toBe(true)
    const ranges = (await queue.listPending()).map((item) => [
      item.range.start_message_id,
      item.range.end_message_id,
    ])
    expect(ranges).toEqual([
      ["m1", "m2"],
      ["m3", "m4"],
    ])
  })
})

describe("facts queue reconcile", () => {
  test("#given a leftover queue file with no completion #when reconcile runs #then it is listed as launchable", async () => {
    // given
    const paths = await identityFixture()
    const queue = new FactsQueue({ identityPaths: paths, now: clockFrom(0) })
    await queue.enqueue(request(journal(2)))

    // when: a fresh process (crash recovery) reads the durable queue
    const recovered = new FactsQueue({ identityPaths: paths, now: clockFrom(90_000) })
    const launchable = await recovered.listPending()

    // then
    expect(launchable).toHaveLength(1)
    expect(launchable[0]?.conversationId).toBe(CONVERSATION)
    expect(launchable[0]?.entries).toHaveLength(4)
  })

  test("#given a malformed queue file #when listPending runs #then it is ignored instead of throwing", async () => {
    // given
    const paths = await identityFixture()
    const queue = new FactsQueue({ identityPaths: paths, now: clockFrom(0) })
    await queue.enqueue(request(journal(2)))
    await writeFile(join(paths.factsQueue, "20260101T000000000Z-deadbeefcafe-12345678.json"), "{ not json")

    // when
    const pending = await queue.listPending()

    // then
    expect(pending).toHaveLength(1)
  })

  test("#given consumed entries #when markConsumed runs #then the files are deleted and the watermark records the endpoint", async () => {
    // given
    const paths = await identityFixture()
    const queue = new FactsQueue({ identityPaths: paths, now: clockFrom(0) })
    await queue.enqueue(request(journal(2)))
    const pending = await queue.listPending()

    // when
    await queue.markConsumed(pending)

    // then
    expect(await queueFileNames(paths)).toHaveLength(0)
    const consumed: unknown = JSON.parse(
      await readFile(factsQueuePaths(paths).consumedPath, "utf8"),
    )
    expect(consumed).toMatchObject({
      version: 1,
      consumed: { [CONVERSATION]: { end_message_id: "m2" } },
    })
  })
})
