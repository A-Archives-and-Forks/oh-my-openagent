import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { FactsFailureStore, factsQueuePaths } from "@oh-my-opencode/memory-core"

import { FactsExtractorRunner } from "./facts-runner"
import { fixture, onlyRunDir, runnerOptions } from "./facts-runner.test-support"
import type { FactsFailurePort } from "./facts-failure-recording"
import { writeRunJsonAtomic } from "./worker/run-artifacts"

const ABANDONED_RUN_ID = "facts-abandoned-1"

/** A seeded record and a clock past its one-minute backoff window (todo 6 gates launches on it). */
const RECORDED_AT = new Date("2026-08-10T12:00:00.000Z")
const ELIGIBLE_AT = new Date("2026-08-10T12:01:00.000Z")

/** Reconcile-only drive: `reconcilePending` reconciles first, then refuses the follow-on launch. */
function reconcileOnly(runner: FactsExtractorRunner) {
  const stop = new AbortController()
  stop.abort()
  return runner.reconcilePending(stop.signal)
}

/** A run whose supervisor identity is unknowable and whose deadline has long passed. */
async function seedUnknownLivenessRun(factsDir: string): Promise<string> {
  const runDir = join(factsDir, "runs", ABANDONED_RUN_ID)
  await mkdir(runDir, { recursive: true })
  await writeRunJsonAtomic(join(runDir, "ledger.json"), {
    version: 1,
    runId: ABANDONED_RUN_ID,
    kind: "facts",
    startedAt: "2026-08-10T12:00:00.000Z",
    hardDeadlineAt: Date.parse("2026-08-10T12:01:00.000Z"),
    terminationGraceMs: 100,
    deadlineAt: Date.parse("2026-08-10T12:01:00.100Z"),
    batchId: "11111111-1111-4111-8111-111111111111",
    queued: [{ conversationId: "session-1", end_message_id: "m1", end_snapshot_line: 1 }],
  })
  return runDir
}

/**
 * Terminal-write observer. The run dir is resolved from the failureId AT RECORD TIME - a
 * late-bound path would make the sentinel-absence assertion vacuous.
 */
function orderingProbe(runsDir: string) {
  const observed: { readonly failureId: string; readonly sentinelExisted: boolean }[] = []
  const port: FactsFailurePort = {
    recordFailure: async (request) => {
      const dir = join(runsDir, request.failureId)
      observed.push({
        failureId: request.failureId,
        sentinelExisted: existsSync(join(dir, "final.json")) || existsSync(join(dir, "abandoned.json")),
      })
    },
    clearOnSuccess: async () => undefined,
  }
  return { observed, port }
}

describe("facts terminal failure recording", () => {
  test("#given a child that exits non-zero #when the run finalizes #then one streak entry is recorded for the queued endpoint", async () => {
    // given
    const { root, identity, queue } = await fixture()
    const runner = new FactsExtractorRunner(runnerOptions(root, identity, queue, "fail"))

    // when
    const result = await runner.launchPending()

    // then
    expect(result.status).toBe("failed")
    const store = new FactsFailureStore({ identityPaths: identity.paths })
    const state = await store.readFailures()
    expect(state.entries).toHaveLength(1)
    expect(state.entries[0]).toMatchObject({
      conversationId: "session-1",
      end_message_id: "m1",
      end_snapshot_line: 1,
      state: "backoff",
      streak: 1,
      lastReason: "child_exit",
      lastFailureId: (await onlyRunDir(identity)).split(/[\\/]/).pop(),
    })
    expect(await queue.listPending()).toHaveLength(1)
  }, 30_000)

  test("#given a failing run #when the failure store is written #then no terminal sentinel exists yet", async () => {
    // given: the ordering contract - a crash between the record and the sentinel is safe,
    // the reverse order would lose the increment forever.
    const { root, identity, queue } = await fixture()
    const probe = orderingProbe(join(identity.paths.facts, "runs"))
    const runner = new FactsExtractorRunner(runnerOptions(root, identity, queue, "fail", {
      failures: probe.port,
    }))

    // when
    const result = await runner.launchPending()
    const runDir = await onlyRunDir(identity)

    // then
    expect(result.status).toBe("failed")
    expect(probe.observed).toEqual([{ failureId: runDir.split(/[\\/]/).pop() ?? "", sentinelExisted: false }])
    expect(existsSync(join(runDir, "final.json"))).toBe(true)
  }, 30_000)

  test("#given finalize crashed after the failure record #when reconcile replays the same runId #then the streak stays at one", async () => {
    // given: the record landed, the sentinel did not - exactly the crash window the ordering buys.
    const { root, identity, queue } = await fixture()
    const crashing = new FactsExtractorRunner(runnerOptions(root, identity, queue, "fail", {
      writeTerminalSentinel: async () => {
        throw new Error("injected crash between failure record and sentinel")
      },
    }))
    await expect(crashing.launchPending()).rejects.toThrow("injected crash")
    const runDir = await onlyRunDir(identity)
    expect(existsSync(join(runDir, "final.json"))).toBe(false)
    const store = new FactsFailureStore({ identityPaths: identity.paths })
    expect((await store.readFailures()).entries[0]).toMatchObject({ streak: 1 })

    // when: a fresh runner reconciles the same run dir, replaying the same runId
    await reconcileOnly(new FactsExtractorRunner(
      runnerOptions(root, identity, queue, "fail", { now: () => new Date("2026-08-11T12:00:00.000Z") }),
    ))

    // then
    expect(existsSync(join(runDir, "final.json"))).toBe(true)
    const state = await store.readFailures()
    expect(state.entries).toHaveLength(1)
    expect(state.entries[0]).toMatchObject({ streak: 1, lastFailureId: runDir.split(/[\\/]/).pop() })
  }, 30_000)

  test("#given a run of unknown liveness past its deadline #when reconcile abandons it #then the failure record precedes the sentinel", async () => {
    // given
    const { root, identity, queue } = await fixture()
    const runDir = await seedUnknownLivenessRun(identity.paths.facts)
    const probe = orderingProbe(join(identity.paths.facts, "runs"))
    const runner = new FactsExtractorRunner(runnerOptions(root, identity, queue, "fail", {
      failures: probe.port,
      now: () => new Date("2026-08-11T12:00:00.000Z"),
    }))

    // when
    await reconcileOnly(runner)

    // then
    expect(existsSync(join(runDir, "abandoned.json"))).toBe(true)
    expect(probe.observed[0]).toEqual({ failureId: ABANDONED_RUN_ID, sentinelExisted: false })
  }, 30_000)

  test("#given a real store #when a run is abandoned #then the queued endpoint carries the unknown_liveness reason", async () => {
    // given
    const { root, identity, queue } = await fixture()
    await seedUnknownLivenessRun(identity.paths.facts)

    // when
    await reconcileOnly(new FactsExtractorRunner(runnerOptions(root, identity, queue, "fail", {
      now: () => new Date("2026-08-11T12:00:00.000Z"),
    })))

    // then
    const state = await new FactsFailureStore({ identityPaths: identity.paths }).readFailures()
    expect(state.entries).toHaveLength(1)
    expect(state.entries[0]).toMatchObject({
      end_message_id: "m1",
      end_snapshot_line: 1,
      streak: 1,
      lastReason: "unknown_liveness",
      lastFailureId: ABANDONED_RUN_ID,
    })
  }, 30_000)

  test("#given a parent_dirty finalize #when the run ends #then the endpoint is recorded with the parent_dirty reason", async () => {
    // given
    const { root, identity, queue } = await fixture()
    let dirty = true
    const runner = new FactsExtractorRunner(runnerOptions(root, identity, queue, "fact", {
      withWriterLock: async (operation) => {
        if (dirty) {
          dirty = false
          await writeFile(join(identity.paths.repo, "foreign.md"), "parent bytes\n")
        }
        return operation()
      },
    }))

    // when
    const result = await runner.launchPending()

    // then
    expect(result.status).toBe("parent_dirty")
    const state = await new FactsFailureStore({ identityPaths: identity.paths }).readFailures()
    expect(state.entries).toHaveLength(1)
    expect(state.entries[0]).toMatchObject({ streak: 1, lastReason: "parent_dirty", state: "backoff" })
  }, 30_000)

  test("#given a recorded failure #when a later run commits #then the endpoint's record is cleared after consumption", async () => {
    // given
    const { root, identity, queue } = await fixture()
    const store = new FactsFailureStore({ identityPaths: identity.paths, now: () => RECORDED_AT })
    await store.recordFailure({
      targets: [{ conversationId: "session-1", endMessageId: "m1", endSnapshotLine: 1 }],
      failureId: "earlier-run",
      reason: "child_exit",
    })
    expect((await store.readFailures()).entries).toHaveLength(1)

    // when: past the record's backoff window, so launch gating lets the endpoint through
    const result = await new FactsExtractorRunner(
      runnerOptions(root, identity, queue, "fact", { now: () => ELIGIBLE_AT }),
    ).launchPending()

    // then
    expect(result.status).toBe("committed")
    expect(await queue.listPending()).toHaveLength(0)
    expect((await store.readFailures()).entries).toEqual([])
  }, 30_000)

  test("#given a queued endpoint with a stale record #when the run yields no facts #then the record is cleared too", async () => {
    // given
    const { root, identity, queue } = await fixture()
    const store = new FactsFailureStore({ identityPaths: identity.paths, now: () => RECORDED_AT })
    await store.recordFailure({
      targets: [{ conversationId: "session-1", endMessageId: "m1", endSnapshotLine: 1 }],
      failureId: "earlier-run",
      reason: "invalid_extraction",
    })

    // when
    const result = await new FactsExtractorRunner(
      runnerOptions(root, identity, queue, "empty", { now: () => ELIGIBLE_AT }),
    ).launchPending()

    // then
    expect(result.status).toBe("no_facts")
    expect((await store.readFailures()).entries).toEqual([])
  }, 30_000)

  test("#given the quick category cannot resolve #when a launch is attempted #then a preflight-scoped failure is recorded", async () => {
    // given
    const { root, identity, queue } = await fixture()
    const runner = new FactsExtractorRunner({
      identity,
      queue,
      cwd: root,
      loadConfig: () => ({ config: { categories: {} }, diagnostics: [], layers: [], sources: [] }),
      resolveModelRegistry: () => ({ getAvailable: () => [], find: () => undefined }),
    })

    // when
    const result = await runner.launchPending()

    // then
    expect(result.status).toBe("skipped")
    const state = await new FactsFailureStore({ identityPaths: identity.paths }).readFailures()
    expect(state.entries).toHaveLength(1)
    expect(state.entries[0]).toMatchObject({ streak: 1, lastReason: "quick_category_unavailable" })
    expect(state.entries[0]?.lastFailureId).toMatch(/^preflight-[0-9a-f-]{36}$/)
    expect(existsSync(join(identity.paths.facts, "runs"))).toBe(false)
  }, 30_000)

  test("#given an aborted drain #when launch is refused before reservation #then nothing is recorded", async () => {
    // given
    const { root, identity, queue } = await fixture()
    const aborted = new AbortController()
    aborted.abort()
    const runner = new FactsExtractorRunner(runnerOptions(root, identity, queue, "fact"))

    // when
    const result = await runner.launchPending(aborted.signal)

    // then
    expect(result.status).toBe("skipped")
    expect(existsSync(factsQueuePaths(identity.paths).failuresPath)).toBe(false)
  }, 30_000)

  test("#given five consecutive failing runs #when each finalizes #then the endpoint parks with a null eligibility", async () => {
    // given
    const { root, identity, queue } = await fixture()
    const store = new FactsFailureStore({ identityPaths: identity.paths })

    // when
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const runner = new FactsExtractorRunner(runnerOptions(root, identity, queue, "fail", {
        now: () => new Date(`2026-08-1${attempt}T12:00:00.000Z`),
      }))
      expect((await runner.launchPending()).status).toBe("failed")
    }

    // then
    const state = await store.readFailures()
    expect(state.entries).toHaveLength(1)
    expect(state.entries[0]).toMatchObject({ state: "parked", streak: 5, nextEligibleAt: null })
    expect(await queue.listPending()).toHaveLength(1)
  }, 60_000)

  test("#given a run ledger #when the run reserves its directory #then queued endpoints carry their snapshot boundary", async () => {
    // given
    const { root, identity, queue } = await fixture()
    const runner = new FactsExtractorRunner(runnerOptions(root, identity, queue, "fail"))

    // when
    await runner.launchPending()

    // then
    const ledger = JSON.parse(await readFile(join(await onlyRunDir(identity), "ledger.json"), "utf8"))
    expect(ledger.queued).toEqual([{ conversationId: "session-1", end_message_id: "m1", end_snapshot_line: 1 }])
  }, 30_000)
})
