import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { realpathSync } from "node:fs"

import { sweepStrandedRunTemporaries, writeRunJsonAtomic } from "./run-artifacts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })))
})

async function workspace(): Promise<string> {
  const root = realpathSync.native(await mkdtemp(join(tmpdir(), "run-artifacts-temp-")))
  roots.push(root)
  return root
}

describe("run artifact temporary hygiene", () => {
  test("#given the rename fails #when an atomic run write aborts #then its temporary is unlinked rather than stranded", async () => {
    // given: the destination is a directory, so the final rename cannot succeed.
    const root = await workspace()
    const target = join(root, "ledger.json")
    await mkdir(target, { recursive: true })

    // when
    await expect(writeRunJsonAtomic(target, { version: 1 })).rejects.toThrow()

    // then
    expect((await readdir(root)).filter((name) => name.includes(".tmp-"))).toEqual([])
  })

  test("#given stranded temporaries from a crashed writer #when the sweep runs #then only tmp siblings are removed", async () => {
    // given
    const root = await workspace()
    await writeRunJsonAtomic(join(root, "ledger.json"), { version: 1 })
    await writeFile(join(root, "ledger.json.tmp-1234-abcd"), "partial", "utf8")
    await writeFile(join(root, "final.json.tmp-9999-efgh"), "partial", "utf8")
    await writeFile(join(root, "child-stderr.log"), "kept", "utf8")

    // when
    const removed = await sweepStrandedRunTemporaries(root)

    // then
    expect(removed).toBe(2)
    expect((await readdir(root)).sort()).toEqual(["child-stderr.log", "ledger.json"])
  })

  test("#given a missing directory #when the sweep runs #then it reports nothing removed instead of throwing", async () => {
    const root = await workspace()

    expect(await sweepStrandedRunTemporaries(join(root, "absent"))).toBe(0)
  })
})
