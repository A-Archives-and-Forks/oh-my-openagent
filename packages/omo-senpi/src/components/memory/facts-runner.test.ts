import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  FactsQueue,
  GitMemoryRepo,
  LockContentionError,
  buildIdentityPaths,
  type MemoryIdentity,
  type TranscriptEntry,
} from "@oh-my-opencode/memory-core"
import type { SenpiModelPort } from "@oh-my-opencode/senpi-task"

import { FactsExtractorRunner, type FactsExtractorRunnerOptions } from "./facts-runner"

const AVAILABLE_MODEL: SenpiModelPort = { provider: "omo-mock", id: "mock-1" }
const childFixture = join(import.meta.dir, "worker", "__fixtures__", "facts-child.ts")
const supervisorFixture = join(import.meta.dir, "worker", "memory-run-supervisor.ts")
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "omo-facts-runner-"))
  tempDirs.push(root)
  const identity: MemoryIdentity = {
    id: "facts-agent",
    safeSlug: "facts-agent",
    paths: buildIdentityPaths(root, "facts-agent"),
  }
  const queue = new FactsQueue({ identityPaths: identity.paths })
  await enqueue(queue, identity, "session-1", "m1", "The project uses Bun.")
  return { root, identity, queue }
}

async function enqueue(
  queue: FactsQueue,
  identity: MemoryIdentity,
  conversationId: string,
  messageId: string,
  text: string,
): Promise<void> {
  const entries: TranscriptEntry[] = [{
    kind: "user",
    text,
    captured_at: "2026-08-10T00:00:00.000Z",
    source_line_id: `${messageId}:user`,
    source_message_id: messageId,
  }]
  await queue.enqueue({
    identity: identity.id,
    sessionId: conversationId,
    conversationId,
    entries,
  })
}

function runnerOptions(
  root: string,
  identity: MemoryIdentity,
  queue: FactsQueue,
  mode: "fact" | "empty" | "malformed" | "fail",
  overrides: Partial<FactsExtractorRunnerOptions> = {},
): FactsExtractorRunnerOptions {
  return {
    identity,
    queue,
    cwd: root,
    loadConfig: () => ({
      config: { categories: { quick: { model: "omo-mock/mock-1" } } },
      diagnostics: [],
      layers: [],
      sources: [],
    }),
    resolveModelRegistry: () => ({
      getAvailable: () => [AVAILABLE_MODEL],
      find: (provider, modelId) =>
        provider === AVAILABLE_MODEL.provider && modelId === AVAILABLE_MODEL.id
          ? AVAILABLE_MODEL
          : undefined,
    }),
    deadlineMs: 10_000,
    terminationGraceMs: 100,
    supervisorPath: supervisorFixture,
    createBatchId: () => "11111111-1111-4111-8111-111111111111",
    sandbox: (args) => ({ ...args, command: process.execPath, args: [childFixture, mode] }),
    now: () => new Date("2026-08-10T12:00:00.000Z"),
    ...overrides,
  }
}

async function onlyRunDir(identity: MemoryIdentity): Promise<string> {
  const runs = join(identity.paths.facts, "runs")
  const names = await readdir(runs)
  expect(names).toHaveLength(1)
  return join(runs, names[0] ?? "missing")
}

describe("quick-pinned facts launch", () => {
  test("#given quick cannot resolve #when pending facts are launched #then no child spawns and the queue stays intact with one warning", async () => {
    // given
    const { root, identity, queue } = await fixture()
    let spawnCount = 0
    const warnings: string[] = []
    const runner = new FactsExtractorRunner({
      identity,
      queue,
      cwd: root,
      loadConfig: () => ({ config: { categories: {} }, diagnostics: [], layers: [], sources: [] }),
      resolveModelRegistry: () => ({ getAvailable: () => [], find: () => undefined }),
      logger: {
        info: () => undefined,
        warn: (message) => warnings.push(message),
        error: () => undefined,
      },
      sandbox: (args) => {
        spawnCount += 1
        return args
      },
    })

    // when
    const result = await runner.launchPending()

    // then
    expect(result.status).toBe("skipped")
    expect(spawnCount).toBe(0)
    expect(warnings).toHaveLength(1)
    expect(await queue.listPending()).toHaveLength(1)
  })

  test("#given two pending queue entries #when one launch runs #then the supervised child consumes all entries in one trailer-bearing commit", async () => {
    // given
    const { root, identity, queue } = await fixture()
    await enqueue(queue, identity, "session-2", "m2", "The project uses TypeScript.")
    const runner = new FactsExtractorRunner(runnerOptions(root, identity, queue, "fact"))

    // when
    const result = await runner.launchPending()

    // then
    expect(result.status).toBe("committed")
    expect(await queue.listPending()).toHaveLength(0)
    const repo = new GitMemoryRepo({ dir: identity.paths.repo, agentId: identity.id })
    const [commit] = await repo.log({ limit: 1 })
    expect(commit?.trailers["Generated-By"]).toBe("facts-extractor")
    expect(commit?.trailers["Omo-Facts-Batch"]).toBe("11111111-1111-4111-8111-111111111111")
    expect(await readFile(join(identity.paths.repo, "notes/facts/2026-08.md"), "utf8")).toContain("fixture consumed 2 queue entries")
    const runDir = await onlyRunDir(identity)
    expect(JSON.parse(await readFile(join(runDir, "final.json"), "utf8"))).toMatchObject({ outcome: "committed" })
    expect(JSON.parse(await readFile(join(runDir, "outcome.json"), "utf8"))).toMatchObject({ childExit: { code: 0 } })
  })

  test("#given a commit lands before queue cleanup crashes #when a fresh runner reconciles #then the batch receipt prevents a duplicate commit", async () => {
    // given
    const { root, identity, queue } = await fixture()
    class FlakyQueue extends FactsQueue {
      private fail = true
      override async markConsumed(entries: Parameters<FactsQueue["markConsumed"]>[0]): Promise<void> {
        if (this.fail) {
          this.fail = false
          throw new Error("injected cleanup crash")
        }
        return super.markConsumed(entries)
      }
    }
    const flaky = new FlakyQueue({ identityPaths: identity.paths })
    const first = new FactsExtractorRunner(runnerOptions(root, identity, flaky, "fact"))
    await expect(first.launchPending()).rejects.toThrow("injected cleanup crash")
    const runDir = await onlyRunDir(identity)
    expect(await readFile(join(runDir, "final.json"), "utf8").catch(() => undefined)).toBeUndefined()

    // when
    const recovered = new FactsExtractorRunner(runnerOptions(root, identity, queue, "fact"))
    const result = await recovered.reconcilePending()

    // then
    expect(result.status).toBe("empty")
    expect(await queue.listPending()).toHaveLength(0)
    const repo = new GitMemoryRepo({ dir: identity.paths.repo, agentId: identity.id })
    expect((await repo.log()).filter((commit) => commit.trailers["Omo-Facts-Batch"] !== undefined)).toHaveLength(1)
    expect(JSON.parse(await readFile(join(runDir, "final.json"), "utf8"))).toMatchObject({ outcome: "committed" })
  })

  test("#given a valid empty extraction #when finalized #then no commit lands and the queue is consumed as no_facts", async () => {
    // given
    const { root, identity, queue } = await fixture()
    const runner = new FactsExtractorRunner(runnerOptions(root, identity, queue, "empty"))

    // when
    const result = await runner.launchPending()

    // then
    expect(result.status).toBe("no_facts")
    expect(await queue.listPending()).toHaveLength(0)
    const runDir = await onlyRunDir(identity)
    expect(JSON.parse(await readFile(join(runDir, "final.json"), "utf8"))).toMatchObject({ outcome: "no_facts" })
  })

  test("#given a schema-invalid project record carrying person #when finalized #then the queue is retained", async () => {
    // given
    const { root, identity, queue } = await fixture()
    const runner = new FactsExtractorRunner(runnerOptions(root, identity, queue, "malformed"))

    // when
    const result = await runner.launchPending()

    // then
    expect(result.status).toBe("failed")
    expect(await queue.listPending()).toHaveLength(1)
    const runDir = await onlyRunDir(identity)
    expect(JSON.parse(await readFile(join(runDir, "final.json"), "utf8"))).toMatchObject({ outcome: "failed" })
  })
})

describe("deterministic facts writer-lock interleavings", () => {
  test("#given the lock releases through the injected retry boundary #when finalization retries #then the batch commits and the queue empties", async () => {
    // given
    const { root, identity, queue } = await fixture()
    const attempts: number[] = []
    let released = false
    const runner = new FactsExtractorRunner(runnerOptions(root, identity, queue, "fact", {
      withWriterLock: async (operation, attempt) => {
        attempts.push(attempt)
        if (!released) throw new LockContentionError("memory-write.lock", null)
        return operation()
      },
      retryDelay: async () => { released = true },
      random: () => 0,
    }))

    // when
    const result = await runner.launchPending()

    // then
    expect(result.status).toBe("committed")
    expect(attempts).toEqual([1, 2])
    expect(await queue.listPending()).toHaveLength(0)
  })

  test("#given the lock remains held for all three attempts #when finalization exhausts retries #then no commit lands and one warning leaves queue and watermarks unchanged", async () => {
    // given
    const { root, identity, queue } = await fixture()
    const before = await queue.readCursor("session-1")
    const attempts: number[] = []
    const delays: number[] = []
    const warnings: string[] = []
    const runner = new FactsExtractorRunner(runnerOptions(root, identity, queue, "fact", {
      withWriterLock: async (_operation, attempt) => {
        attempts.push(attempt)
        throw new LockContentionError("memory-write.lock", null)
      },
      retryDelay: async (attempt) => { delays.push(attempt) },
      logger: {
        info: () => undefined,
        warn: (message) => warnings.push(message),
        error: () => undefined,
      },
      random: () => 0,
    }))

    // when
    const result = await runner.launchPending()

    // then
    expect(result.status).toBe("failed")
    expect(attempts).toEqual([1, 2, 3])
    expect(delays).toEqual([1, 2])
    expect(warnings).toHaveLength(1)
    expect(await queue.listPending()).toHaveLength(1)
    expect(await queue.readCursor("session-1")).toEqual(before)
    const repo = new GitMemoryRepo({ dir: identity.paths.repo, agentId: identity.id })
    expect((await repo.log()).filter((commit) => commit.trailers["Generated-By"] === "facts-extractor")).toHaveLength(0)
  })
})
