import { afterEach, describe, expect, test } from "bun:test"
import { realpathSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { GitMemoryRepo } from "@oh-my-opencode/memory-core"

import {
  createMemoryRpcGitRepo,
  estimateSystemTokens,
  memoryTreeStats,
} from "./memory-rpc-snapshot-state"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })))
})

async function fixtureRepo(): Promise<{ dir: string; repo: GitMemoryRepo; head: string }> {
  const dir = realpathSync.native(await mkdtemp(join(tmpdir(), "memory-rpc-snapshot-")))
  tempDirs.push(dir)
  const repo = new GitMemoryRepo({ dir, agentId: "omo-memory-rpc" })
  const head = await repo.init({
    seedFiles: [
      { relativePath: "system/persona.md", content: "persona\n" },
      { relativePath: "system/nested/guide.md", content: "guide 🧠\n" },
      { relativePath: "system/theme.css", content: "/* not markdown */\n" },
      { relativePath: "notes.md", content: "working notes\n" },
      { relativePath: "journal/day.md", content: "journal\n" },
    ],
  })
  return { dir, repo, head }
}

async function estimateSystemTokensLegacy(
  repo: GitMemoryRepo,
  head: string,
): Promise<number> {
  const paths = (await repo.lsTree(head)).filter((path) => path.startsWith("system/") && path.endsWith(".md"))
  const contents = await Promise.all(paths.map((path) => repo.show(head, path)))
  const totalBytes = contents.reduce((sum, content) => sum + Buffer.byteLength(content, "utf8"), 0)
  return Math.floor(totalBytes / 4)
}

describe("estimateSystemTokens", () => {
  test("#given system and non-system markdown #when estimated from lsTreeSized #then the result matches the old per-path show loop", async () => {
    // given
    const { dir, repo, head } = await fixtureRepo()
    const reference = await estimateSystemTokensLegacy(repo, head)

    // when
    const estimate = await estimateSystemTokens(createMemoryRpcGitRepo(dir), head, new Map())

    // then
    expect(reference).toBeGreaterThan(0)
    expect(estimate).toBe(reference)
  })
})

describe("memoryTreeStats", () => {
  test("#given a sized tree listing #when summarized #then totals isolate system bytes and group by top-level path", () => {
    // given
    const entries = [
      { path: "system/persona.md", bytes: 40 },
      { path: "system/nested/guide.md", bytes: 8 },
      { path: "notes.md", bytes: 20 },
      { path: "journal/day.md", bytes: 12 },
    ]

    // when
    const stats = memoryTreeStats(entries)

    // then
    expect(stats).toEqual({
      totalBytes: 80,
      fileCount: 4,
      systemBytes: 48,
      byTopLevel: { system: 48, "notes.md": 20, journal: 12 },
    })
  })
})
