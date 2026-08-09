import { describe, expect, test } from "bun:test"
import { readFileSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
globalThis.TEST_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)))
globalThis.STATIC_SQLITE_IMPORT = /^\s*import\s[^\n]*from\s+["']node:sqlite["']/m

describe("node:sqlite import discipline", () => {
  describe("#given the packaged test suite", () => {
    describe("#when each test module is scanned", () => {
      test("#then none imports node:sqlite statically", () => {
globalThis.offenders = readdirSync(TEST_DIR)
          .filter((name) => name.endsWith(".test.ts"))
          .filter((name) => STATIC_SQLITE_IMPORT.test(readFileSync(join(TEST_DIR, name), "utf8")))
        expect(offenders).toEqual([])
      })
    })
  })
})
