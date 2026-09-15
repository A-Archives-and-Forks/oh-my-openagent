import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createGoalJsonCache } from "./footer-status"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function goalFile(): string {
  const root = mkdtempSync(join(tmpdir(), "omo-senpi-goal-cache-"))
  roots.push(root)
  return join(root, "goal.json")
}

function writeGoalWithPinnedMtime(path: string, status: string, mtimeMs: number): void {
  writeFileSync(path, `${JSON.stringify({ version: 1, goal: { status } })}\n`)
  utimesSync(path, mtimeMs / 1000, mtimeMs / 1000)
}

describe("ulw-loop goal JSON cache", () => {
  it("#given a fresh goal rewritten within the same mtime granule #when it is read again #then the rewritten document is returned", () => {
    const path = goalFile()
    const cache = createGoalJsonCache()
    const stamp = Date.now()
    writeGoalWithPinnedMtime(path, "active", stamp)
    expect(cache.read(path)).toMatchObject({ goal: { status: "active" } })

    writeGoalWithPinnedMtime(path, "complete", stamp)
    expect(cache.read(path)).toMatchObject({ goal: { status: "complete" } })
  })

  it("#given a goal that has been quiet for longer than the racy window #when its bytes change under the same mtime #then a size change still forces a re-read", () => {
    const path = goalFile()
    const cache = createGoalJsonCache()
    const stamp = Date.now() - 60_000
    writeGoalWithPinnedMtime(path, "active", stamp)
    expect(cache.read(path)).toMatchObject({ goal: { status: "active" } })

    writeGoalWithPinnedMtime(path, "complete", stamp)
    expect(cache.read(path)).toMatchObject({ goal: { status: "complete" } })
  })

  it("#given a goal that has been quiet for longer than the racy window #when mtime and size are unchanged #then the cached document is trusted without a re-read", () => {
    const path = goalFile()
    const cache = createGoalJsonCache()
    const stamp = Date.now() - 60_000
    writeGoalWithPinnedMtime(path, "active", stamp)
    expect(cache.read(path)).toMatchObject({ goal: { status: "active" } })

    const sameLengthAsActive = "paused"
    writeGoalWithPinnedMtime(path, sameLengthAsActive, stamp)
    expect(cache.read(path)).toMatchObject({ goal: { status: "active" } })
  })

  it("#given a cached goal #when the file disappears #then the entry is dropped and a later rewrite is read fresh", () => {
    const path = goalFile()
    const cache = createGoalJsonCache()
    const stamp = Date.now() - 60_000
    writeGoalWithPinnedMtime(path, "active", stamp)
    expect(cache.read(path)).toMatchObject({ goal: { status: "active" } })

    rmSync(path)
    expect(cache.read(path)).toBeUndefined()

    writeGoalWithPinnedMtime(path, "complete", stamp)
    expect(cache.read(path)).toMatchObject({ goal: { status: "complete" } })
  })
})
