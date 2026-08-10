import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { FactsPayload, ReflectionWorktree, ReservedRun } from "@oh-my-opencode/memory-core"

import { prepareFactsSpawn, prepareReflectionSpawn } from "./spawn"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function chmodFailure(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`chmod failed: ${code}`), { code })
}

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "omo-memory-spawn-"))
  roots.push(path)
  return path
}

const payload: FactsPayload = {
  version: 1,
  identity: "agent-test",
  today: "2026-08-10",
  entries: [],
  knownPeople: [],
  primaryHuman: { slug: "human", aliases: [] },
}

const run: ReservedRun = {
  runId: "run-1",
  request: { trigger: "manual", conversationIds: [], snapshots: [] },
}

describe("worker payload mode relaxation", () => {
  test("#given a missing facts payload from the first launch #when mode relaxation reports ENOENT #then preparation continues", async () => {
    const runDir = await root()

    const prepared = await prepareFactsSpawn({
      runId: "facts-1",
      runDir,
      payload,
      model: "provider/model",
      env: {},
      chmodFile: async () => { throw chmodFailure("ENOENT") },
    })

    expect(prepared.paths.payload).toBe(join(runDir, "facts-payload.json"))
  })

  test("#given facts payload mode relaxation fails unexpectedly #when preparation runs #then the chmod failure is surfaced", async () => {
    const runDir = await root()

    const failure = await prepareFactsSpawn({
      runId: "facts-1",
      runDir,
      payload,
      model: "provider/model",
      env: {},
      chmodFile: async () => { throw chmodFailure("EPERM") },
    }).catch((error: unknown) => error)

    expect((failure as NodeJS.ErrnoException).code).toBe("EPERM")
  })

  test("#given reflection payload mode relaxation fails unexpectedly #when preparation runs #then the chmod failure is surfaced", async () => {
    const base = await root()
    const sessionDir = join(base, "sessions")

    const failure = await prepareReflectionSpawn({
      run,
      worktree: {
        dir: base,
        commonConfigPath: join(base, "config"),
      } as unknown as ReflectionWorktree,
      reflectionSessionsDir: sessionDir,
      model: "provider/model",
      env: {},
      mergePolicy: "auto",
      skillsUsageSource: join(base, "skills.json"),
      dreamStateSource: join(base, "dream.json"),
      peoplePolicy: { enabled: true, max_entries: 40, max_entry_chars: 200 },
      chmodFile: async () => { throw chmodFailure("EACCES") },
    }).catch((error: unknown) => error)

    expect((failure as NodeJS.ErrnoException).code).toBe("EACCES")
  })
})
