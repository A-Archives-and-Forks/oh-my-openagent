import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { preflightMemoryModels, resetModelPreflightCacheForTests } from "./model-preflight"
import type { MemoryModelChain } from "./memory-model-attempts"

const roots: string[] = []
afterEach(async () => {
  resetModelPreflightCacheForTests()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const candidates: MemoryModelChain = [
  { model: "extension-only/primary", thinking: "off" },
  { model: "builtin/fallback", thinking: "minimal" },
]

async function fixture(body: string): Promise<{
  readonly root: string
  readonly launch: { readonly command: string; readonly prefixArgs: readonly string[] }
  readonly config: string
}> {
  const root = await mkdtemp(join(tmpdir(), "memory-model-preflight-"))
  roots.push(root)
  const launcher = join(root, "fake-senpi.mjs")
  const config = join(root, "omo.jsonc")
  await writeFile(launcher, `${body}\n`, "utf8")
  await writeFile(config, "{}\n", "utf8")
  return { root, launch: { command: process.execPath, prefixArgs: [launcher] }, config }
}

describe("preflightMemoryModels", () => {
  test("#given a clean child catalog #when candidates are preflighted #then only child-visible candidates remain in order", async () => {
    // given
    const item = await fixture('process.stdout.write("builtin/fallback\\nother/model\\n")')

    // when
    const result = await preflightMemoryModels({
      candidates,
      launch: item.launch,
      env: { PATH: process.env.PATH },
      configSources: [{ path: item.config, exists: true }],
    })

    // then
    expect(result).toEqual({
      kind: "filtered",
      candidates: [{ model: "builtin/fallback", thinking: "minimal" }],
      rejected: [{ model: "extension-only/primary", cause: "model_not_visible" }],
    })
  })

  test("#given the same launcher and config mtime #when preflight runs twice #then the child catalog is probed once", async () => {
    // given
    const item = await fixture(`
import { appendFileSync } from "node:fs"
appendFileSync(process.env.PROBE_LOG, "probe\\n")
process.stdout.write("builtin/fallback\\n")
`)
    const probeLog = join(item.root, "probes.log")
    const input = {
      candidates,
      launch: item.launch,
      env: { PATH: process.env.PATH, PROBE_LOG: probeLog },
      configSources: [{ path: item.config, exists: true }],
    }

    // when
    await preflightMemoryModels(input)
    await preflightMemoryModels(input)

    // then
    expect(await Bun.file(probeLog).text()).toBe("probe\n")
  })

  test("#given a changed config mtime #when preflight runs again #then it refreshes the child catalog", async () => {
    // given
    const item = await fixture(`
import { appendFileSync } from "node:fs"
appendFileSync(process.env.PROBE_LOG, "probe\\n")
process.stdout.write("builtin/fallback\\n")
`)
    const probeLog = join(item.root, "probes.log")
    const input = {
      candidates,
      launch: item.launch,
      env: { PATH: process.env.PATH, PROBE_LOG: probeLog },
      configSources: [{ path: item.config, exists: true }],
    }
    await preflightMemoryModels(input)
    const before = await stat(item.config)
    await writeFile(item.config, "{\n}\n", "utf8")
    await Bun.sleep(1)
    const after = await stat(item.config)
    if (after.mtimeMs === before.mtimeMs) await writeFile(item.config, "{\n  // changed\n}\n", "utf8")

    // when
    await preflightMemoryModels(input)

    // then
    expect((await Bun.file(probeLog).text()).trim().split("\n")).toHaveLength(2)
  })

  test("#given a launcher whose grandchild holds the output pipes #when the probe times out #then it degrades without waiting for the grandchild", async () => {
    // given
    const item = await fixture("")
    const wrapper = join(item.root, "wrapper.mjs")
    const grandchildPidPath = join(item.root, "grandchild.pid")
    await writeFile(wrapper, `
import { spawn } from "node:child_process"
import { writeFileSync } from "node:fs"
const child = spawn(process.execPath, ["-e", "setInterval(() => undefined, 30_000)"], { stdio: ["ignore", "inherit", "inherit"] })
writeFileSync(process.env.GRANDCHILD_PID, String(child.pid))
setInterval(() => undefined, 30_000)
`, "utf8")
    const startedAt = Date.now()
    const probe = preflightMemoryModels({
      candidates,
      launch: { command: process.execPath, prefixArgs: [wrapper] },
      env: { PATH: process.env.PATH, GRANDCHILD_PID: grandchildPidPath },
      configSources: [{ path: item.config, exists: true }],
      timeoutMs: 50,
    })
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        await stat(grandchildPidPath)
        break
      } catch {
        await new Promise<void>((resolve) => setTimeout(resolve, 1))
      }
    }
    let cleanupPid: number | undefined

    // when
    const result = await Promise.race([
      probe,
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 500)),
    ]).finally(async () => {
      try {
        cleanupPid = Number((await readFile(grandchildPidPath, "utf8")).trim())
        process.kill(cleanupPid, "SIGKILL")
      } catch {
        // The fixed path has already detached from the pipe-holding grandchild.
      }
    })

    // then
    expect(result).toEqual({ kind: "unavailable", candidates })
    expect(Date.now() - startedAt).toBeLessThan(500)
    if (cleanupPid !== undefined) await probe
  })

  test("#given a failed child catalog probe #when candidates are preflighted #then it warns and preserves reactive fallback behavior", async () => {
    // given
    const item = await fixture('process.stderr.write("probe failed"); process.exit(7)')
    const warnings: string[] = []

    // when
    const result = await preflightMemoryModels({
      candidates,
      launch: item.launch,
      env: { PATH: process.env.PATH },
      configSources: [{ path: item.config, exists: true }],
      warn: (message, details) => warnings.push(`${message}: ${JSON.stringify(details)}`),
    })

    // then
    expect(result).toEqual({ kind: "unavailable", candidates })
    expect(warnings.join("\n")).toContain("exited with code 7")
  })
})
