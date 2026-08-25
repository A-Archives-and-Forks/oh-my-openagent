import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  buildSenpiArgs,
  provisionEmbeddedRuntime,
  remapSenpiEnvironment,
  versionLine,
  updateLine,
  type EmbeddedManifest,
} from "../compile-entry"

const roots: string[] = []
const temp = () => { const root = mkdtempSync(join(homedir(), "omo-compile-entry-test-")); roots.push(root); return root }
const sha = (value: string) => createHash("sha256").update(value).digest("hex")

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe("compiled omo entry launcher parity", () => {
  test("early commands pass through without an extension", () => {
    expect(buildSenpiArgs(["install", "x"], "/provisioned")).toEqual(["install", "x"])
  })

  test("main commands prepend the provisioned plugin extension", () => {
    expect(buildSenpiArgs(["chat"], "/provisioned")).toEqual(["--extension", join("/provisioned", "plugin"), "chat"])
  })

  test("version line reads the sibling package version and pinned engine", () => {
    expect(versionLine({ version: "9.2.1" }, "2026.8.24")).toBe("omo 9.2.1 (engine: senpi 2026.8.24)")
  })

  test("self-update prints the curl reinstall command", () => {
    expect(updateLine("darwin-arm64")).toContain("curl -fsSL")
    expect(updateLine("darwin-arm64")).toContain("omo-darwin-arm64")
  })

  test("package-root environment values point into the provisioned runtime", () => {
    const env = remapSenpiEnvironment({ OMO_BIN: "/old", SENPI_BIN: "/old-senpi", PATH: "/bin" }, "/provisioned")
    expect(env.OMO_AGENT_TOOLKIT_BIN).toBe(join("/provisioned", "bin", "omo-agent-toolkit.js"))
    expect(env.OMO_BIN).toBe(join("/provisioned", "bin", "omo.js"))
    expect(env.OMO_CODING_AGENT_DIR).toBeDefined()
  })
})

describe("embedded runtime provisioning", () => {
  test("materializes files with sha256 and mode, then skips on matching marker", async () => {
    const root = temp()
    const content = "hello runtime\n"
    const manifest: EmbeddedManifest = {
      omoAiVersion: "9.2.1",
      enginePin: "2026.8.24",
      manifestSha: "manifest-sha",
      entries: [{ relPath: "package.json", sha256: sha(content), mode: 0o644, size: Buffer.byteLength(content) }],
    }
    const embedded = [{ name: "package.json", text: async () => content }] as any[]
    const runtime = join(root, "runtime")
    await provisionEmbeddedRuntime(manifest, embedded, runtime)
    expect(readFileSync(join(runtime, "package.json"), "utf8")).toBe(content)
    expect(statSync(join(runtime, "package.json")).mode & 0o777).toBe(0o644)
    expect(readFileSync(join(runtime, ".provisioned"), "utf8")).toBe("manifest-sha\n")
    writeFileSync(join(runtime, "package.json"), "changed\n")
    await provisionEmbeddedRuntime(manifest, embedded, runtime)
    expect(readFileSync(join(runtime, "package.json"), "utf8")).toBe("changed\n")
  })
})
