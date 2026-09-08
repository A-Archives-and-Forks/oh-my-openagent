import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { realpathSync } from "node:fs"
import { buildIdentityPaths, type MemoryIdentity } from "@oh-my-opencode/memory-core"

import { writeRunJsonAtomic } from "./run-artifacts"
import { writeCompletionRecord } from "./completion-records"
import { reconcileReflectionRuns } from "./run-reconciliation"

const roots: string[] = []
const NOW = Date.parse("2026-09-08T00:00:00.000Z")
const OLD = new Date(NOW - 2 * 24 * 60 * 60_000)

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })))
})

async function workspace(): Promise<string> {
  const root = realpathSync.native(await mkdtemp(join(tmpdir(), "run-artifacts-temp-")))
  roots.push(root)
  return root
}

describe("run artifact temporary hygiene", () => {
  test("#given the rename fails #when an atomic run write aborts #then its temporary is unlinked", async () => {
    const root = await workspace()
    const target = join(root, "ledger.json")
    await mkdir(target)

    await expect(writeRunJsonAtomic(target, { version: 1 })).rejects.toThrow()

    expect(await readdir(root)).toEqual(["ledger.json"])
  })

  test("#given serialization fails after opening the temporary #when a run write aborts #then the temporary is unlinked", async () => {
    const root = await workspace()

    await expect(writeRunJsonAtomic(join(root, "ledger.json"), { value: 1n })).rejects.toThrow()

    expect(await readdir(root)).toEqual([])
  })

  test("#given the completion destination blocks rename #when publication fails #then its temporary is unlinked", async () => {
    const root = await workspace()
    await mkdir(join(root, "run-1.json"))

    await expect(writeCompletionRecord(root, {
      schemaVersion: 1, runId: "run-1", identity: "agent-test", category: "quick",
      conversationIds: [], trigger: "manual", outcome: "failed",
      startedAt: OLD.toISOString(), finishedAt: new Date(NOW).toISOString(),
      delivery: { status: "pending" },
    })).rejects.toThrow()

    expect(await readdir(root)).toEqual(["run-1.json"])
  })

  test("#given stranded temporaries in terminal run and completion directories #when startup reconciles #then only abandoned old siblings are removed", async () => {
    const root = await workspace()
    const identity: MemoryIdentity = { id: "agent-test", safeSlug: "agent-test", paths: buildIdentityPaths(root, "agent-test") }
    const runDir = join(identity.paths.reflection, "runs", "run-1")
    const completionsDir = join(identity.paths.reflection, "completions")
    for (const dir of [runDir, completionsDir]) {
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, "final.json"), "{}")
      await writeFile(join(dir, "final.json.tmp-legacy"), "partial")
      await utimes(join(dir, "final.json.tmp-legacy"), OLD, OLD)
      await writeFile(join(dir, "final.json.tmp-fresh"), "writing")
      await utimes(join(dir, "final.json.tmp-fresh"), new Date(NOW), new Date(NOW))
      await writeFile(join(dir, `ledger.json.tmp-${process.pid}-live`), "writing")
      await utimes(join(dir, `ledger.json.tmp-${process.pid}-live`), OLD, OLD)
      await mkdir(join(dir, "directory.tmp-keep"))
    }

    await reconcileReflectionRuns({
      identity,
      reservation: { readState: async () => ({}), complete: async () => { throw new Error("unexpected completion") } },
      now: () => NOW,
      getPidLiveness: () => "alive",
    })

    for (const dir of [runDir, completionsDir]) {
      expect((await readdir(dir)).sort()).toEqual([
        "directory.tmp-keep", "final.json", "final.json.tmp-fresh", `ledger.json.tmp-${process.pid}-live`,
      ].sort())
    }
  })

  test("#given no reflection directories #when startup reconciles #then maintenance remains a no-op", async () => {
    const root = await workspace()
    const identity: MemoryIdentity = { id: "agent-test", safeSlug: "agent-test", paths: buildIdentityPaths(root, "agent-test") }

    expect(await reconcileReflectionRuns({
      identity,
      reservation: { readState: async () => ({}), complete: async () => { throw new Error("unexpected completion") } },
      now: () => NOW,
    })).toEqual([])
  })
})
