import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
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

async function fixture(body: string): Promise<{ readonly root: string; readonly launcher: string; readonly config: string }> {
  const root = await mkdtemp(join(tmpdir(), "memory-model-preflight-"))
  roots.push(root)
  const launcher = join(root, "fake-senpi")
  const config = join(root, "omo.jsonc")
  await writeFile(launcher, `#!/bin/sh\n${body}\n`, "utf8")
  await chmod(launcher, 0o700)
  await writeFile(config, "{}\n", "utf8")
  return { root, launcher, config }
}

describe("preflightMemoryModels", () => {
  test("#given a clean child catalog #when candidates are preflighted #then only child-visible candidates remain in order", async () => {
    // given
    const item = await fixture('printf "builtin/fallback\\nother/model\\n"')

    // when
    const result = await preflightMemoryModels({
      candidates,
      launch: { command: item.launcher, prefixArgs: [] },
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
    const item = await fixture('echo probe >> "$PROBE_LOG"; printf "builtin/fallback\\n"')
    const probeLog = join(item.root, "probes.log")
    const input = {
      candidates,
      launch: { command: item.launcher, prefixArgs: [] as readonly string[] },
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
    const item = await fixture('echo probe >> "$PROBE_LOG"; printf "builtin/fallback\\n"')
    const probeLog = join(item.root, "probes.log")
    const input = {
      candidates,
      launch: { command: item.launcher, prefixArgs: [] as readonly string[] },
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

  test("#given a failed child catalog probe #when candidates are preflighted #then it warns and preserves reactive fallback behavior", async () => {
    // given
    const item = await fixture('printf "probe failed" >&2; exit 7')
    const warnings: string[] = []

    // when
    const result = await preflightMemoryModels({
      candidates,
      launch: { command: item.launcher, prefixArgs: [] },
      env: { PATH: process.env.PATH },
      configSources: [{ path: item.config, exists: true }],
      warn: (message, details) => warnings.push(`${message}: ${JSON.stringify(details)}`),
    })

    // then
    expect(result).toEqual({ kind: "unavailable", candidates })
    expect(warnings.join("\n")).toContain("exited with code 7")
  })
})
