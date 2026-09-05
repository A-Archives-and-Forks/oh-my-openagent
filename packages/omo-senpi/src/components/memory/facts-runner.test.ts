import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { FactsFailureStore, FactsQueue, GitMemoryRepo, factsQueuePaths } from "@oh-my-opencode/memory-core"
import type { SenpiModelPort } from "@oh-my-opencode/senpi-task"
import { FactsExtractorRunner } from "./facts-runner"
import { enqueue, fixture, onlyRunDir, runnerOptions } from "./facts-runner.test-support"
import { writeRunJsonAtomic } from "./worker/run-artifacts"
describe("quick-pinned facts launch", () => {
  test("#given quick cannot resolve #when pending facts are launched #then no child spawns and the queue stays intact with one warning", async () => {
    // given
    const { root, identity, queue } = await fixture()
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
    })

    // when
    const result = await runner.launchPending()

    // then
    expect(result.status).toBe("skipped")
    expect(warnings).toHaveLength(1)
    expect(await queue.listPending()).toHaveLength(1)
  }, 30_000)
  test("#given a registry without quick but with another usable model #when pending facts are launched #then the beyond-category resolution is refused instead of launched", async () => {
    // given: the quick chain is dead (no category config, no `omo-mock` model) while the registry
    // still offers a usable model, so `resolveReflectionModel` answers `resolved` through its
    // beyond-category ladder and tags it `source: "registry_fallback"`. A quick-PINNED surface
    // must treat that as unavailable: an unattended extraction may never land on an arbitrary,
    // possibly frontier-priced model.
    const { root, identity, queue } = await fixture()
    const beyondCategory: SenpiModelPort = { provider: "other-provider", id: "expensive-1" }
    const warnings: string[] = []
    const runner = new FactsExtractorRunner({
      identity,
      queue,
      cwd: root,
      loadConfig: () => ({ config: { categories: {} }, diagnostics: [], layers: [], sources: [] }),
      resolveModelRegistry: () => ({
        getAvailable: () => [beyondCategory],
        find: (provider, modelId) =>
          provider === beyondCategory.provider && modelId === beyondCategory.id ? beyondCategory : undefined,
      }),
      logger: {
        info: () => undefined,
        warn: (message) => warnings.push(message),
        error: () => undefined,
      },
    })

    // when
    const result = await runner.launchPending()

    // then: identical skip semantics to the `category_unavailable` path - one warning, no child,
    // no run dir, queue intact, and the preflight-scoped failure/backoff record still lands.
    expect(result.status).toBe("skipped")
    expect(warnings).toHaveLength(1)
    expect(await queue.listPending()).toHaveLength(1)
    expect(existsSync(join(identity.paths.facts, "runs"))).toBe(false)
    const state = await new FactsFailureStore({ identityPaths: identity.paths }).readFailures()
    expect(state.entries).toHaveLength(1)
    expect(state.entries[0]).toMatchObject({ streak: 1, lastReason: "quick_category_unavailable" })
    expect(state.entries[0]?.lastFailureId).toMatch(/^preflight-[0-9a-f-]{36}$/)
  }, 30_000)

  test("#given two pending queue entries #when one launch runs #then the supervised child consumes all entries in one trailer-bearing commit", async () => {
    // given
    const { root, identity, queue } = await fixture()
    await enqueue(queue, identity, "session-2", "m2", "The project uses TypeScript.")
    const runner = new FactsExtractorRunner(runnerOptions(root, identity, queue, "fact", {
      createBatchId: () => "11111111-1111-4111-8111-111111111111",
    }))

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
    const ledger = JSON.parse(await readFile(join(runDir, "ledger.json"), "utf8"))
    expect(JSON.parse(await readFile(join(runDir, "final.json"), "utf8"))).toMatchObject({ outcome: "committed" })
    expect(JSON.parse(await readFile(join(runDir, "outcome.json"), "utf8"))).toMatchObject({ childExit: { code: 0 } })
    expect(ledger.applyRecovery).toMatchObject({
      version: 1,
      batchId: "11111111-1111-4111-8111-111111111111",
      headBeforeApply: ledger.headBeforeApply,
      people: { enabled: true, maxEntries: 40, maxEntryChars: 200 },
    })
    expect(ledger.applyRecovery.recordsHash).toMatch(/^[0-9a-f]{64}$/)
    expect(ledger.applyRecovery.paths.map((entry: { path: string }) => entry.path)).toEqual(
      [...ledger.applyRecovery.paths].map((entry: { path: string }) => entry.path).sort(),
    )
  }, 90_000)

  test("#given a quick primary absent from the registry and a present fallback #when facts extraction launches #then the fallback launches as attempt 2 and commits", async () => {
    // given
    const { root, identity, queue } = await fixture()
    const warnings: string[] = []
    const base = runnerOptions(root, identity, queue, "model-fallback", {
      logger: {
        info: () => undefined,
        warn: (message) => warnings.push(message),
        error: () => undefined,
      },
    })
    let primaryLookups = 0
    const runner = new FactsExtractorRunner({
      ...base,
      resolveModelRegistry: () => ({
        getAvailable: () => [{ provider: "extension-only", id: "primary" }, { provider: "omo-mock", id: "mock-1" }],
        find: (provider, modelId) => {
          if (provider === "extension-only") {
            primaryLookups += 1
            return primaryLookups === 1 ? { provider, id: modelId } : undefined
          }
          return provider === "omo-mock" && modelId === "mock-1" ? { provider, id: modelId } : undefined
        },
      }),
    })

    // when
    const result = await runner.launchPending()
    const runDir = await onlyRunDir(identity)
    const final = JSON.parse(await readFile(join(runDir, "final.json"), "utf8"))

    // then
    expect({ status: result.status, detail: final.detail }).toEqual({ status: "committed", detail: undefined })
    expect(JSON.parse(await readFile(join(runDir, "ledger.json"), "utf8"))).toMatchObject({ attempt: 2, model: "omo-mock/mock-1" })
    expect(JSON.parse(await readFile(join(runDir, "outcome.json"), "utf8"))).toMatchObject({ attempt: 2 })
    expect(warnings.filter((message) => message.includes("facts model candidate skipped"))).toHaveLength(1)
    expect(await queue.listPending()).toHaveLength(0)
  }, 60_000)

  test("#given an in-process child that never settles #when the deadline expires #then timedOut is durable and finalization records deadline failure", async () => {
    // given
    const { root, identity, queue } = await fixture()
    const runner = new FactsExtractorRunner(runnerOptions(root, identity, queue, "timeout", { deadlineMs: 5 }))

    // when
    const result = await runner.launchPending()
    const runDir = await onlyRunDir(identity)

    // then
    expect(result.status).toBe("failed")
    expect(JSON.parse(await readFile(join(runDir, "outcome.json"), "utf8"))).toMatchObject({ timedOut: true, childExit: { code: null } })
    expect(JSON.parse(await readFile(join(runDir, "final.json"), "utf8"))).toMatchObject({ outcome: "failed" })
  }, 30_000)

  test("#given facts attempt two has a stale attempt-one outcome #when reconciled before the shared deadline #then the retry remains active", async () => {
    // given
    const { root, identity, queue } = await fixture()
    const runDir = join(identity.paths.facts, "runs", "facts-retry")
    await mkdir(runDir, { recursive: true })
    await writeRunJsonAtomic(join(runDir, "ledger.json"), {
      version: 1,
      runId: "facts-retry",
      kind: "facts",
      attempt: 2,
      model: "omo-mock/mock-1",
      startedAt: "2026-08-10T12:00:00.000Z",
      hardDeadlineAt: Date.parse("2026-08-10T12:01:00.000Z"),
      terminationGraceMs: 100,
      deadlineAt: Date.parse("2026-08-10T12:01:00.100Z"),
      batchId: "11111111-1111-4111-8111-111111111111",
      queued: [],
    })
    await writeRunJsonAtomic(join(runDir, "outcome.json"), {
      version: 1,
      runId: "facts-retry",
      attempt: 1,
      finishedAt: "2026-08-10T12:00:01.000Z",
      childExit: { code: 1, signal: null },
      timedOut: false,
    })
    const warnings: string[] = []
    const runner = new FactsExtractorRunner(runnerOptions(root, identity, queue, "fact", {
      logger: {
        info: () => undefined,
        warn: (message) => { warnings.push(message) },
        error: () => undefined,
      },
    }))

    // when
    const result = await runner.reconcilePending()

    // then
    expect(result.status).toBe("active")
    expect(warnings).toEqual([])
    expect(await queue.listPending()).toHaveLength(1)
    expect(existsSync(join(runDir, "final.json"))).toBe(false)
  }, 30_000)

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
    await writeFile(join(identity.paths.repo, "foreign.md"), "parent bytes\n")

    // when: receipt probing must win before dirty-state recovery classification
    const recovered = new FactsExtractorRunner(runnerOptions(root, identity, queue, "fact"))
    const result = await recovered.reconcilePending()

    // then
    expect(result.status).toBe("empty")
    expect(await queue.listPending()).toHaveLength(0)
    const repo = new GitMemoryRepo({ dir: identity.paths.repo, agentId: identity.id })
    expect((await repo.log()).filter((commit) => commit.trailers["Omo-Facts-Batch"] !== undefined)).toHaveLength(1)
    expect(await readFile(join(identity.paths.repo, "foreign.md"), "utf8")).toBe("parent bytes\n")
    expect(JSON.parse(await readFile(join(runDir, "final.json"), "utf8"))).toMatchObject({ outcome: "committed" })
  }, 30_000)

  test("#given a legacy dirty run without an envelope #when retried after cleanup #then it fails closed, retains queue watermarks, and later commits", async () => {
    const { root, identity, queue } = await fixture()
    const paths = factsQueuePaths(identity.paths)
    const cursorPath = paths.cursorPath("session-1")
    const cursorBefore = await readFile(cursorPath, "utf8")
    const consumedBefore = await readFile(paths.consumedPath, "utf8").catch(() => undefined)
    let injectDirty = true
    const first = new FactsExtractorRunner(runnerOptions(root, identity, queue, "fact", {
      withWriterLock: async (operation) => {
        if (injectDirty) {
          injectDirty = false
          await writeFile(join(identity.paths.repo, "foreign.md"), "parent bytes\n")
        }
        return operation()
      },
    }))

    const blocked = await first.launchPending()

    expect(blocked.status).toBe("parent_dirty")
    expect(await queue.listPending()).toHaveLength(1)
    expect(await readFile(cursorPath, "utf8")).toBe(cursorBefore)
    expect(await readFile(paths.consumedPath, "utf8").catch(() => undefined)).toBe(consumedBefore)
    const firstRun = await onlyRunDir(identity)
    expect(JSON.parse(await readFile(join(firstRun, "final.json"), "utf8"))).toMatchObject({ outcome: "parent_dirty" })
    expect(JSON.parse(await readFile(join(firstRun, "ledger.json"), "utf8")).applyRecovery).toBeUndefined()

    await rm(join(identity.paths.repo, "foreign.md"))
    // The blocked run recorded a one-minute backoff; the retry clock clears that window.
    const retried = await new FactsExtractorRunner(runnerOptions(root, identity, queue, "fact", {
      now: () => new Date("2026-08-10T12:01:00.000Z"),
    })).launchPending()

    expect(retried.status).toBe("committed")
    expect(await queue.listPending()).toHaveLength(0)
    expect((await readdir(join(identity.paths.facts, "runs"))).length).toBe(2)
  }, 30_000)

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
  }, 30_000)

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
  }, 30_000)
})
