import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { FactsQueue, GitMemoryRepo, LockContentionError } from "@oh-my-opencode/memory-core"
import { OmoMemorySettingsSchema } from "@oh-my-opencode/omo-config-core"
import { FactsExtractorRunner } from "./facts-runner"
import { enqueue, fixture, onlyRunDir, runnerOptions } from "./facts-runner.test-support"

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

  test("#given an extension-only quick primary and a child-visible fallback #when facts extraction launches #then it retries and commits with the fallback", async () => {
    // given
    const { root, identity, queue } = await fixture()
    const attempted: string[] = []
    const base = runnerOptions(root, identity, queue, "model-fallback")
    const runner = new FactsExtractorRunner({
      ...base,
      sandbox: (args) => {
        const modelIndex = args.args.indexOf("--model")
        attempted.push(args.args[modelIndex + 1] ?? "missing")
        return base.sandbox?.(args) ?? args
      },
    })

    // when
    const result = await runner.launchPending()

    // then
    expect({ status: result.status, attempted }).toEqual({
      status: "committed",
      attempted: ["extension-only/primary", "omo-mock/mock-1"],
    })
    expect(await queue.listPending()).toHaveLength(0)
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
