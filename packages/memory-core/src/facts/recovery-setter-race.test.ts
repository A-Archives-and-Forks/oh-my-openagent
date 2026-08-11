import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { GitMemoryRepo } from "../git"
import { buildDefaultSeedFiles } from "../seeds"
import type { FactsBatch } from "./extraction"
import { planFactsMutation } from "./mutation-plan"
import { applyFactsRecovery } from "./recovery"

const AUTHOR = { agentId: "facts-setter-race", authorName: "Facts Setter Race" }
const tempDirs: string[] = []

function batch(): FactsBatch {
  return {
    batchId: "11111111-1111-4111-8111-111111111111",
    records: [
      { scope: "project", text: "August.", date: "2026-08-10" },
      { scope: "project", text: "September.", date: "2026-09-01" },
    ],
  }
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "facts-setter-race-"))
  tempDirs.push(dir)
  const repo = new GitMemoryRepo({ dir, agentId: AUTHOR.agentId })
  await repo.init({ seedFiles: buildDefaultSeedFiles() })
  return { dir, repo }
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("facts conditional mutation primitives", () => {
  test("refuses a foreign creation injected inside the final worktree setter", async () => {
    const { dir, repo } = await fixture()
    const recovery = await planFactsMutation(repo, batch(), undefined)
    const paths = recovery.paths.map((entry) => entry.path)
    const foreignPath = paths[0]!
    const originalWrite = repo.pathState.writeWorktreeIfIdentity.bind(repo.pathState)
    const indexBefore = new Map(paths.map((path) => [path, recovery.paths.find((entry) => entry.path === path)!.pre.index]))
    repo.pathState.writeWorktreeIfIdentity = async (path, expected, next) => {
      repo.pathState.writeWorktreeIfIdentity = originalWrite
      await mkdir(dirname(join(dir, foreignPath)), { recursive: true })
      await writeFile(join(dir, foreignPath), "foreign inside worktree setter\n")
      return originalWrite(path, expected, next)
    }

    const result = await applyFactsRecovery(repo, recovery, 2, AUTHOR)

    expect(result.outcome).toBe("parent_dirty")
    expect(await readFile(join(dir, foreignPath), "utf8")).toBe("foreign inside worktree setter\n")
    for (const path of paths) expect((await repo.pathState.capture(path)).index).toEqual(indexBefore.get(path) ?? null)
    for (const path of paths.slice(1)) expect(await repo.pathState.capture(path)).toEqual(
      recovery.paths.find((entry) => entry.path === path)!.pre,
    )
    expect((await repo.log()).some((commit) => commit.trailers["Omo-Facts-Batch"] === recovery.batchId)).toBe(false)
  })

  test("refuses a foreign staged OID injected inside the final index setter", async () => {
    const { repo } = await fixture()
    const recovery = await planFactsMutation(repo, batch(), undefined)
    const paths = recovery.paths.map((entry) => entry.path)
    const foreignPath = paths[0]!
    const foreignOid = await repo.pathState.hashIndexBlob(foreignPath, "foreign staged inside setter\n", true)
    const originalSet = repo.pathState.writeIndexIfIdentity.bind(repo.pathState)
    repo.pathState.writeIndexIfIdentity = async (path, expected, next) => {
      repo.pathState.writeIndexIfIdentity = originalSet
      await repo.pathState.setIndex(foreignPath, { mode: "100644", oid: foreignOid })
      return originalSet(path, expected, next)
    }

    const result = await applyFactsRecovery(repo, recovery, 2, AUTHOR)

    expect(result.outcome).toBe("parent_dirty")
    expect((await repo.pathState.capture(foreignPath)).index).toEqual({ mode: "100644", oid: foreignOid })
    for (const path of paths.slice(1)) expect(await repo.pathState.capture(path)).toEqual(
      recovery.paths.find((entry) => entry.path === path)!.pre,
    )
    expect((await repo.log()).some((commit) => commit.trailers["Omo-Facts-Batch"] === recovery.batchId)).toBe(false)
  })
})
