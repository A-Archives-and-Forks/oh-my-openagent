import { describe, expect, test } from "bun:test"
import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"

const SOURCE_ROOT = path.resolve(import.meta.dir, "..")
const RESILIENT_MODULE = path.join(SOURCE_ROOT, "fs", "resilient.ts")
const DIRECT_NODE_FS = /(?:from\s+|require\()\s*"node:fs(?:\/promises)?"/

function collectSourceFiles(root: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(entryPath))
      continue
    }
    if (!entry.name.endsWith(".ts")) continue
    if (entry.name.endsWith(".test.ts")) continue
    if (entry.name.includes("test-support")) continue
    files.push(entryPath)
  }
  return files
}

describe("memory-core fs boundary", () => {
  test("production sources import fs only through the resilient module", () => {
    const offenders = collectSourceFiles(SOURCE_ROOT)
      .filter((file) => file !== RESILIENT_MODULE)
      .filter((file) => DIRECT_NODE_FS.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(SOURCE_ROOT, file))
    expect(offenders).toEqual([])
  })
})
