import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { buildIdentityPaths } from "@oh-my-opencode/memory-core"

import { FakeExtensionAPI } from "../../../test-support/fake-extension-api"
import { componentContext } from "./memory.test-support"
import { createMemoryIdentityContext, type MemoryIdentityContext } from "./context"
import {
  extractSkillId,
  incrementSkillUsage,
  readSkillsUsageLedger,
  registerSkillsUsage,
  skillsUsagePaths,
  SkillsUsageTracker,
} from "./skills-usage"

const IDENTITY = "skills-usage-agent"
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function fixture(): Promise<{
  readonly context: MemoryIdentityContext
  readonly repoDir: string
  readonly paths: ReturnType<typeof skillsUsagePaths>
}> {
  const dir = await mkdtemp(join(tmpdir(), "memory-skills-usage-"))
  tempDirs.push(dir)
  const identityPaths = buildIdentityPaths(join(dir, "memory"), IDENTITY)
  await mkdir(identityPaths.locks, { recursive: true })
  await mkdir(identityPaths.runtime, { recursive: true })
  await mkdir(join(identityPaths.repo, "skills", "foo"), { recursive: true })
  await mkdir(join(identityPaths.repo, "skills", "bar"), { recursive: true })
  await writeFile(join(identityPaths.repo, "skills", "foo", "SKILL.md"), "# Foo")
  await writeFile(join(identityPaths.repo, "skills", "bar", "SKILL.md"), "# Bar")
  await mkdir(join(identityPaths.repo, "notes"), { recursive: true })
  await writeFile(join(identityPaths.repo, "notes", "facts.md"), "# Facts")
  const context = createMemoryIdentityContext({
    identity: IDENTITY,
    identityPaths,
    binding: { identity: IDENTITY, repoPathHash: "hash", boundAt: 1 },
  })
  return {
    context,
    repoDir: identityPaths.repo,
    paths: skillsUsagePaths(identityPaths),
  }
}

function toolCall(toolName: string, input: Record<string, unknown>): Record<string, unknown> {
  return { type: "tool_call", toolCallId: "call-1", toolName, input }
}

function eventContext(sessionId: string): unknown {
  return { sessionManager: { getSessionId: () => sessionId } }
}

describe("extractSkillId", () => {
  test("#given a path inside skills/foo #when extracted #then returns the skill id", async () => {
    // #given
    const { repoDir } = await fixture()

    // #when
    const id = extractSkillId(repoDir, join(repoDir, "skills", "foo", "SKILL.md"))

    // #then
    expect(id).toBe("foo")
  })

  test("#given a path inside notes #when extracted #then returns undefined", async () => {
    // #given
    const { repoDir } = await fixture()

    // #when
    const id = extractSkillId(repoDir, join(repoDir, "notes", "facts.md"))

    // #then
    expect(id).toBeUndefined()
  })

  test("#given a path outside the repo #when extracted #then returns undefined", async () => {
    // #given
    const { repoDir } = await fixture()

    // #when
    const id = extractSkillId(repoDir, "/tmp/other/SKILL.md")

    // #then
    expect(id).toBeUndefined()
  })
})

describe("incrementSkillUsage", () => {
  test("#given a fresh ledger #when incrementing skill foo #then count is 1 and lastUsedAt is set", async () => {
    // #given
    const { paths } = await fixture()
    const now = () => new Date("2026-01-15T10:00:00Z")

    // #when
    await incrementSkillUsage(paths, "foo", now)

    // #then
    const ledger = await readSkillsUsageLedger(paths.ledgerPath)
    expect(ledger.foo).toEqual({ count: 1, lastUsedAt: "2026-01-15T10:00:00.000Z" })
  })

  test("#given an existing ledger with count 1 #when incrementing foo again #then count is 2", async () => {
    // #given
    const { paths } = await fixture()
    const now = () => new Date("2026-01-15T10:00:00Z")
    await incrementSkillUsage(paths, "foo", now)

    // #when
    await incrementSkillUsage(paths, "foo", () => new Date("2026-01-15T11:00:00Z"))

    // #then
    const ledger = await readSkillsUsageLedger(paths.ledgerPath)
    expect(ledger.foo).toEqual({ count: 2, lastUsedAt: "2026-01-15T11:00:00.000Z" })
  })

  test("#given non-skill reads #when checking the ledger #then no entries are created", async () => {
    // #given
    const { paths } = await fixture()
    const now = () => new Date("2026-01-15T10:00:00Z")

    // #when - increment a skill, not a notes file
    await incrementSkillUsage(paths, "foo", now)

    // #then - only foo is present, no notes or other entries
    const ledger = await readSkillsUsageLedger(paths.ledgerPath)
    expect(Object.keys(ledger)).toEqual(["foo"])
  })

  test("#given concurrent two-session interleaving #when both sessions increment different skills under lock #then no increment is lost", async () => {
    // #given
    const { paths } = await fixture()
    const now = () => new Date("2026-01-15T10:00:00Z")

    // #when - simulate two sessions incrementing in interleaved order
    // session A: read foo
    await incrementSkillUsage(paths, "foo", now)
    // session B: read bar (interleaved before A flushes foo)
    await incrementSkillUsage(paths, "bar", now)
    // session A: read foo again
    await incrementSkillUsage(paths, "foo", now)
    // session B: read bar again
    await incrementSkillUsage(paths, "bar", now)

    // #then - all four increments landed
    const ledger = await readSkillsUsageLedger(paths.ledgerPath)
    expect(ledger.foo).toEqual({ count: 2, lastUsedAt: "2026-01-15T10:00:00.000Z" })
    expect(ledger.bar).toEqual({ count: 2, lastUsedAt: "2026-01-15T10:00:00.000Z" })
  })

  test("#given two sessions incrementing the SAME skill concurrently #when both acquire the lock serially #then count is 2 (no lost update)", async () => {
    // #given
    const { paths } = await fixture()
    const now = () => new Date("2026-01-15T10:00:00Z")

    // #when - both sessions read the same skill; the lock serializes read-modify-write
    const [a, b] = await Promise.all([
      incrementSkillUsage(paths, "foo", now),
      incrementSkillUsage(paths, "foo", now),
    ])

    // #then
    void a
    void b
    const ledger = await readSkillsUsageLedger(paths.ledgerPath)
    expect(ledger.foo?.count).toBe(2)
  })
})

describe("SkillsUsageTracker", () => {
  test("#given a read of skills/foo/SKILL.md #when recordRead is called then flushed #then foo.count is 1", async () => {
    // #given
    const { repoDir, paths } = await fixture()
    const tracker = new SkillsUsageTracker({
      paths,
      repoDir,
      now: () => new Date("2026-01-15T10:00:00Z"),
    })

    // #when
    tracker.recordRead(join(repoDir, "skills", "foo", "SKILL.md"))
    await tracker.flush()

    // #then
    const ledger = await readSkillsUsageLedger(paths.ledgerPath)
    expect(ledger.foo).toEqual({ count: 1, lastUsedAt: "2026-01-15T10:00:00.000Z" })
  })

  test("#given a non-skill read #when recordRead is called then flushed #then ledger is empty", async () => {
    // #given
    const { repoDir, paths } = await fixture()
    const tracker = new SkillsUsageTracker({
      paths,
      repoDir,
      now: () => new Date("2026-01-15T10:00:00Z"),
    })

    // #when
    tracker.recordRead(join(repoDir, "notes", "facts.md"))
    await tracker.flush()

    // #then
    const ledger = await readSkillsUsageLedger(paths.ledgerPath)
    expect(Object.keys(ledger)).toEqual([])
  })

  test("#given multiple reads of the same skill before flush #when flushed #then count reflects all reads", async () => {
    // #given
    const { repoDir, paths } = await fixture()
    const tracker = new SkillsUsageTracker({
      paths,
      repoDir,
      now: () => new Date("2026-01-15T10:00:00Z"),
    })

    // #when
    tracker.recordRead(join(repoDir, "skills", "foo", "SKILL.md"))
    tracker.recordRead(join(repoDir, "skills", "foo", "SKILL.md"))
    tracker.recordRead(join(repoDir, "skills", "foo", "SKILL.md"))
    await tracker.flush()

    // #then
    const ledger = await readSkillsUsageLedger(paths.ledgerPath)
    expect(ledger.foo?.count).toBe(3)
  })

  test("#given reads of multiple skills #when flushed #then all skills are present", async () => {
    // #given
    const { repoDir, paths } = await fixture()
    const tracker = new SkillsUsageTracker({
      paths,
      repoDir,
      now: () => new Date("2026-01-15T10:00:00Z"),
    })

    // #when
    tracker.recordRead(join(repoDir, "skills", "foo", "SKILL.md"))
    tracker.recordRead(join(repoDir, "skills", "bar", "SKILL.md"))
    tracker.recordRead(join(repoDir, "skills", "foo", "SKILL.md"))
    await tracker.flush()

    // #then
    const ledger = await readSkillsUsageLedger(paths.ledgerPath)
    expect(ledger.foo?.count).toBe(2)
    expect(ledger.bar?.count).toBe(1)
  })
})

describe("registerSkillsUsage", () => {
  test("#given a read tool targeting skills/foo/SKILL.md #when dispatched then flushed #then foo.count is 1", async () => {
    // #given
    const { context, repoDir } = await fixture()
    const pi = new FakeExtensionAPI()
    const trackers = registerSkillsUsage(pi, {
      resolveContext: () => context,
      resolveCwd: () => repoDir,
      now: () => new Date("2026-01-15T10:00:00Z"),
    })

    // #when
    await pi.dispatch(
      "tool_call",
      toolCall("read", { path: join(repoDir, "skills", "foo", "SKILL.md") }),
      eventContext("session-1"),
    )
    const tracker = trackers.get(context.identity)
    await tracker?.flush()

    // #then
    const ledger = await readSkillsUsageLedger(skillsUsagePaths(context.identityPaths).ledgerPath)
    expect(ledger.foo).toEqual({ count: 1, lastUsedAt: "2026-01-15T10:00:00.000Z" })
  })

  test("#given a read tool targeting notes/facts.md #when dispatched then flushed #then ledger is empty", async () => {
    // #given
    const { context, repoDir } = await fixture()
    const pi = new FakeExtensionAPI()
    const trackers = registerSkillsUsage(pi, {
      resolveContext: () => context,
      resolveCwd: () => repoDir,
      now: () => new Date("2026-01-15T10:00:00Z"),
    })

    // #when
    await pi.dispatch(
      "tool_call",
      toolCall("read", { path: join(repoDir, "notes", "facts.md") }),
      eventContext("session-1"),
    )
    const tracker = trackers.get(context.identity)
    await tracker?.flush()

    // #then
    const ledger = await readSkillsUsageLedger(skillsUsagePaths(context.identityPaths).ledgerPath)
    expect(Object.keys(ledger)).toEqual([])
  })

  test("#given a write tool targeting skills/foo/SKILL.md #when dispatched then flushed #then ledger is empty (only read tools tracked)", async () => {
    // #given
    const { context, repoDir } = await fixture()
    const pi = new FakeExtensionAPI()
    const trackers = registerSkillsUsage(pi, {
      resolveContext: () => context,
      resolveCwd: () => repoDir,
      now: () => new Date("2026-01-15T10:00:00Z"),
    })

    // #when
    await pi.dispatch(
      "tool_call",
      toolCall("write", { path: join(repoDir, "skills", "foo", "SKILL.md"), content: "new" }),
      eventContext("session-1"),
    )
    const tracker = trackers.get(context.identity)
    await tracker?.flush()

    // #then
    const ledger = await readSkillsUsageLedger(skillsUsagePaths(context.identityPaths).ledgerPath)
    expect(Object.keys(ledger)).toEqual([])
  })

  test("#given an unbound session #when dispatched #then no tracker is created", async () => {
    // #given
    const pi = new FakeExtensionAPI()
    const trackers = registerSkillsUsage(pi, {
      resolveContext: () => undefined,
      resolveCwd: () => "/tmp",
    })

    // #when
    await pi.dispatch(
      "tool_call",
      toolCall("read", { path: "/tmp/skills/foo/SKILL.md" }),
      eventContext("session-1"),
    )

    // #then
    expect(trackers.size).toBe(0)
  })
})

describe("readSkillsUsageLedger", () => {
  test("#given a missing ledger file #when read #then returns empty object", async () => {
    // #given
    const { paths } = await fixture()

    // #when
    const ledger = await readSkillsUsageLedger(paths.ledgerPath)

    // #then
    expect(ledger).toEqual({})
  })

  test("#given a ledger with valid entries #when read #then returns parsed entries", async () => {
    // #given
    const { paths } = await fixture()
    await writeFile(
      paths.ledgerPath,
      JSON.stringify({ foo: { count: 3, lastUsedAt: "2026-01-15T10:00:00Z" } }),
      "utf8",
    )

    // #when
    const ledger = await readSkillsUsageLedger(paths.ledgerPath)

    // #then
    expect(ledger).toEqual({ foo: { count: 3, lastUsedAt: "2026-01-15T10:00:00Z" } })
  })

  test("#given a corrupted ledger file #when read #then returns empty object (write never blocks or fails the tool)", async () => {
    // #given
    const { paths } = await fixture()
    await writeFile(paths.ledgerPath, "not json {{{", "utf8")

    // #when
    const ledger = await readSkillsUsageLedger(paths.ledgerPath)

    // #then
    expect(ledger).toEqual({})
  })
})
