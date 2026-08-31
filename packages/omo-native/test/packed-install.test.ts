import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const packageRoot = join(import.meta.dir, "..")

describe("omo-ai packed install", () => {
  test("ships and applies the Senpi patch installer from the packed artifact", () => {
    const root = mkdtempSync(join(tmpdir(), "omo-ai-packed-install-"))
    try {
      const pack = Bun.spawnSync(["bun", "pm", "pack", "--ignore-scripts", "--destination", root], { cwd: packageRoot, stdout: "pipe", stderr: "pipe" })
      expect(pack.exitCode).toBe(0)
      const tarball = [...new Bun.Glob("*.tgz").scanSync(root)][0]
      expect(tarball).toBeDefined()
      const listing = Bun.spawnSync(["tar", "-tzf", join(root, tarball!)], { stdout: "pipe", stderr: "pipe" })
      expect(listing.exitCode).toBe(0)
      expect(new TextDecoder().decode(listing.stdout)).toContain("package/senpi-patch.mjs\n")

      const consumer = join(root, "consumer")
      Bun.spawnSync(["mkdir", "-p", consumer], { stdout: "ignore", stderr: "ignore" })
      writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "omo-ai-consumer", private: true }))
      const install = Bun.spawnSync(["bun", "add", "--trust", join(root, tarball!)], { cwd: consumer, stdout: "pipe", stderr: "pipe" })
      expect(install.exitCode).toBe(0)
      const installedScript = join(consumer, "node_modules", "omo-ai", "senpi-patch.mjs")
      expect(readFileSync(installedScript, "utf8")).toContain("isCompleteHookStateSnapshot")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)
})
