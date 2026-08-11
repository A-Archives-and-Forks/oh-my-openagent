import { afterEach, describe, expect, test } from "bun:test"
import { lstat, mkdir, mkdtemp, readFile, rm, rmdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { GitMemoryRepo } from "../git"
import { buildDefaultSeedFiles } from "../seeds"
import { applyFactsBatch } from "./extraction"
import { planFactsMutation, type FactsApplyRecovery } from "./mutation-plan"
import { applyFactsRecovery } from "./recovery"

const AUTHOR = { agentId: "facts-reservation-race", authorName: "Facts Reservation Race" }
const tempDirs: string[] = []

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "facts-reservation-race-"))
  tempDirs.push(dir)
  const repo = new GitMemoryRepo({ dir, agentId: AUTHOR.agentId })
  await repo.init({ seedFiles: buildDefaultSeedFiles() })
  await applyFactsBatch(repo, {
    batchId: "11111111-1111-4111-8111-111111111111",
    records: [{ scope: "project", text: "Initial August.", date: "2026-08-01" }],
  }, AUTHOR)
  return { dir, repo }
}

async function deletionRecovery(repo: GitMemoryRepo): Promise<FactsApplyRecovery> {
  const planned = await planFactsMutation(repo, {
    batchId: "22222222-2222-4222-8222-222222222222",
    records: [
      { scope: "project", text: "August update.", date: "2026-08-10" },
      { scope: "project", text: "September.", date: "2026-09-01" },
    ],
  }, undefined)
  const august = "notes/facts/2026-08.md"
  const current = await repo.pathState.capture(august)
  if (current.index === null || current.worktree.kind !== "file") throw new Error("expected August")
  return {
    ...planned,
    paths: planned.paths.map((entry) => entry.path === august ? {
      path: august,
      pre: { index: null, worktree: { kind: "missing" as const } },
      post: { index: current.index!, worktree: current.worktree as Extract<typeof current.worktree, { kind: "file" }> },
    } : entry),
  }
}

function expectNoReceipt(repo: GitMemoryRepo, batchId: string): Promise<void> {
  return repo.log().then((commits) => {
    expect(commits.some((commit) => commit.trailers["Omo-Facts-Batch"] === batchId)).toBe(false)
  })
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("facts deletion reservation finalization", () => {
  test("preserves a foreign directory replacing the verified reservation", async () => {
    const { dir, repo } = await fixture()
    const recovery = await deletionRecovery(repo)
    const target = join(dir, "notes/facts/2026-08.md")
    const originalReserve = repo.pathState.reserveWorktreeDeletion.bind(repo.pathState)
    let deletionResult: boolean | undefined
    let foreignIdentity: { dev: number; ino: number } | undefined
    repo.pathState.reserveWorktreeDeletion = async (path, moved) => {
      repo.pathState.reserveWorktreeDeletion = originalReserve
      const reservation = await originalReserve(path, moved)
      if (reservation === undefined) return undefined
      return {
        verify: async () => {
          const finalizer = await reservation.verify()
          if (finalizer === undefined) return undefined
          await rmdir(target)
          await mkdir(target)
          const foreign = await lstat(target)
          foreignIdentity = { dev: foreign.dev, ino: foreign.ino }
          return {
            finish: async () => {
              deletionResult = await finalizer.finish()
              return deletionResult
            },
          }
        },
      }
    }

    const result = await applyFactsRecovery(repo, recovery, 2, AUTHOR)
    const remaining = await lstat(target)

    expect(result.outcome).toBe("parent_dirty")
    expect(deletionResult).toBe(false)
    expect(remaining.isDirectory()).toBe(true)
    if (foreignIdentity === undefined) throw new Error("foreign directory was not installed")
    expect({ dev: remaining.dev, ino: remaining.ino }).toEqual(foreignIdentity)
    await expectNoReceipt(repo, recovery.batchId)
  })

  test("preserves a foreign file replacing the verified reservation and returns parent_dirty", async () => {
    const { dir, repo } = await fixture()
    const recovery = await deletionRecovery(repo)
    const august = "notes/facts/2026-08.md"
    const september = "notes/facts/2026-09.md"
    const target = join(dir, august)
    const indexBefore = await repo.pathState.captureAll([august, september])
    const originalReserve = repo.pathState.reserveWorktreeDeletion.bind(repo.pathState)
    repo.pathState.reserveWorktreeDeletion = async (path, moved) => {
      repo.pathState.reserveWorktreeDeletion = originalReserve
      const reservation = await originalReserve(path, moved)
      if (reservation === undefined) return undefined
      return {
        verify: async () => {
          const finalizer = await reservation.verify()
          if (finalizer === undefined) return undefined
          await rmdir(target)
          await writeFile(target, "foreign finalization sentinel\n")
          return finalizer
        },
      }
    }

    const outcome = await applyFactsRecovery(repo, recovery, 2, AUTHOR)
      .then((result) => result.outcome, () => "failed" as const)

    expect(outcome).toBe("parent_dirty")
    expect(await readFile(target, "utf8")).toBe("foreign finalization sentinel\n")
    expect((await repo.pathState.capture(august)).index).toEqual(indexBefore.get(august)?.index ?? null)
    expect((await repo.pathState.capture(september)).index).toEqual(indexBefore.get(september)?.index ?? null)
    expect(await repo.pathState.capture(september)).toEqual(recovery.paths.find((entry) => entry.path === september)!.pre)
    await expectNoReceipt(repo, recovery.batchId)
  })
})
