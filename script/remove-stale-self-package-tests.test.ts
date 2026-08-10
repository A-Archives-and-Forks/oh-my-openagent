import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { removeStaleSelfPackageTests } from "./remove-stale-self-package-tests"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe("removeStaleSelfPackageTests", () => {
  test("#given package-local self-package tests #when cleanup runs #then only stale self copies are removed", async () => {
    // given
    const root = await mkdtemp(join(tmpdir(), "omo-stale-self-package-"))
    tempDirs.push(root)
    const staleOpenCode = join(root, "packages", "adapter-a", "node_modules", "oh-my-opencode")
    const staleOpenAgent = join(root, "packages", "adapter-b", "node_modules", "oh-my-openagent")
    const unrelated = join(root, "packages", "adapter-b", "node_modules", "unrelated-package")
    await Promise.all([
      writeFixture(staleOpenCode),
      writeFixture(staleOpenAgent),
      writeFixture(unrelated),
    ])

    // when
    const removed = await removeStaleSelfPackageTests(root)

    // then
    expect(removed).toEqual([
      "packages/adapter-a/node_modules/oh-my-opencode",
      "packages/adapter-b/node_modules/oh-my-openagent",
    ])
    await expectPathMissing(staleOpenCode)
    await expectPathMissing(staleOpenAgent)
    expect((await stat(unrelated)).isDirectory()).toBe(true)
  })

  test("#given the root CI workflow #when steps are ordered #then stale self tests are removed before bun test", async () => {
    // given
    const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8")

    // when
    const installIndex = workflow.indexOf("      - name: Install dependencies")
    const cleanupIndex = workflow.indexOf("      - name: Remove stale self-package test copies")
    const testIndex = workflow.indexOf("      - name: Run tests")

    // then
    expect(installIndex).toBeGreaterThanOrEqual(0)
    expect(cleanupIndex).toBeGreaterThan(installIndex)
    expect(testIndex).toBeGreaterThan(cleanupIndex)
    expect(workflow).toContain("run: bun run script/remove-stale-self-package-tests.ts")
  })
})

async function writeFixture(path: string): Promise<void> {
  await mkdir(join(path, "src"), { recursive: true })
  await writeFile(join(path, "src", "stale.test.ts"), "test('stale', () => {})\n")
}

async function expectPathMissing(path: string): Promise<void> {
  try {
    await stat(path)
    throw new Error(`expected path to be missing: ${path}`)
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return
    throw error
  }
}
