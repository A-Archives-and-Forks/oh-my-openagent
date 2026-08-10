import { afterEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"

import {
  GitMemoryRepo,
  buildIdentityPaths,
  loadDreamPersona,
  type MemoryIdentity,
  type ReservedRun,
} from "@oh-my-opencode/memory-core"
import { OmoMemorySettingsSchema, type OmoConfig } from "@oh-my-opencode/omo-config-core"
import type { SenpiModelPort } from "@oh-my-opencode/senpi-task"

import type { SenpiOmoConfigResult } from "../../config-resolution"
import { SenpiSubprocessRunner } from "./runner"
import type { ReflectionSpawnArgs } from "./spawn"

const childFixture = join(import.meta.dir, "__fixtures__", "dream-child.ts")
const supervisorFixture = join(import.meta.dir, "memory-run-supervisor.ts")
const roots: string[] = []

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

async function launchDream(
  people: { enabled: boolean; max_entries: number; max_entry_chars: number },
  options: { readonly seedLedgers?: boolean } = {},
): Promise<{
  readonly identity: MemoryIdentity
  readonly result: Awaited<ReturnType<SenpiSubprocessRunner["launch"]>>
  readonly spawn: ReflectionSpawnArgs
}> {
  const root = await mkdtemp(join(tmpdir(), "memory-dream-dispatch-"))
  roots.push(root)
  const identity: MemoryIdentity = {
    id: "agent-test",
    safeSlug: "agent-test",
    paths: buildIdentityPaths(root, "agent-test"),
  }
  const repo = new GitMemoryRepo({ dir: identity.paths.repo, agentId: identity.id })
  await repo.init({ seedFiles: [{ relativePath: "system/base.md", content: "---\ndescription: Base\n---\nBase.\n" }] })
  if (options.seedLedgers !== false) {
    await mkdir(join(identity.paths.runtime, "dream"), { recursive: true })
    await writeFile(join(identity.paths.runtime, "skills-usage.json"), `${JSON.stringify({
      review: { count: 2, lastUsedAt: "2026-08-01T00:00:00.000Z" },
    })}\n`)
    await writeFile(join(identity.paths.runtime, "dream", "state.json"), `${JSON.stringify({
      last_dream_at: "2026-07-01T00:00:00.000Z",
      lastRunId: "prior-run",
    })}\n`)
  }

  const memory = OmoMemorySettingsSchema.parse({
    reflection: { category: "quick", merge: "auto", sandbox: "off" },
    people: { enabled: true, max_entries: 40, max_entry_chars: 200 },
    agents: { "agent-test": { people } },
  })
  const config: OmoConfig = { memory, categories: { quick: { model: "omo-mock/mock-1", reasoning: "high" } } }
  const loaded: SenpiOmoConfigResult = { config, diagnostics: [], layers: [], sources: [] }
  const model: SenpiModelPort = { provider: "omo-mock", id: "mock-1" }
  const calls: ReflectionSpawnArgs[] = []
  const runner = new SenpiSubprocessRunner({
    identity,
    reservation: { complete: async (_runId, outcome) => ({ outcome }) },
    resolveModelRegistry: () => ({
      getAvailable: () => [model],
      find: (provider, modelId) => provider === model.provider && modelId === model.id ? model : undefined,
    }),
    loadConfig: () => loaded,
    cwd: root,
    env: options.seedLedgers === false ? { DREAM_FIXTURE_EMPTY_LEDGERS: "1" } : {},
    deadlineMs: 5_000,
    supervisorPath: supervisorFixture,
    sandbox: (spawn) => {
      calls.push(spawn)
      return { ...spawn, command: process.execPath, args: [childFixture] }
    },
  })
  const run: ReservedRun = {
    runId: "dream-run-1",
    request: { trigger: "dream", origin: "manual", conversationIds: [], snapshots: [] },
  }
  const result = await runner.launch(run)
  const spawn = calls[0]
  if (!spawn) throw new Error("expected dream spawn")
  return { identity, result, spawn }
}

describe("dream worker dispatch", () => {
  test("#given a dream with people disabled #when the worker launches #then it selects dream inputs and touches no people path", async () => {
    // given
    const expectedPolicy = { version: 1, people: { enabled: false, max_entries: 7, max_entry_chars: 80 } }

    // when
    const item = await launchDream(expectedPolicy.people)

    // then
    expect(item.result.outcome).toBe("merged")
    expect(await readFile(item.spawn.paths.persona, "utf8")).toBe(loadDreamPersona().markdown)
    expect(basename(item.spawn.env.SKILLS_USAGE_PATH ?? "")).toBe("skills-usage.json")
    expect(basename(item.spawn.env.DREAM_STATE_PATH ?? "")).toBe("dream-state.json")
    expect(basename(item.spawn.env.DREAM_POLICY_PATH ?? "")).toBe("dream-policy.json")
    expect(JSON.parse(await readFile(item.spawn.env.DREAM_POLICY_PATH ?? "", "utf8"))).toEqual(expectedPolicy)
    expect(existsSync(join(item.identity.paths.repo, "people"))).toBe(false)
  })

  test("#given absent dream ledgers #when the worker launches #then it supplies readable empty objects", async () => {
    // given
    const people = { enabled: false, max_entries: 40, max_entry_chars: 200 }

    // when
    const item = await launchDream(people, { seedLedgers: false })

    // then
    expect(item.result.outcome).toBe("merged")
    expect(JSON.parse(await readFile(item.spawn.env.SKILLS_USAGE_PATH ?? "", "utf8"))).toEqual({})
    expect(JSON.parse(await readFile(item.spawn.env.DREAM_STATE_PATH ?? "", "utf8"))).toEqual({})
  })

  test("#given custom people limits #when the dream writes fixture entries #then it honors the resolved limits exactly", async () => {
    // given
    const limits = { enabled: true, max_entries: 3, max_entry_chars: 64 }

    // when
    const item = await launchDream(limits)

    // then
    expect(item.result.outcome).toBe("merged")
    const lines = (await readFile(join(item.identity.paths.repo, "people", "fixture", "card.md"), "utf8")).trim().split("\n")
    expect(lines).toHaveLength(limits.max_entries)
    expect(lines.every((line) => line.length === limits.max_entry_chars)).toBe(true)
  })
})
