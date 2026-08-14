// allow: SIZE_OK - acceptance tests keep the crash-safety matrix together and use shared real-directory fixtures.
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { createHash } from "node:crypto"
import * as fs from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createDagFileStore, DagJournalCorruptError } from "./store"
import type { DagRunEvent, DagRunId } from "./types"

const cleanupRoots: string[] = []
const runId = "run-1" as DagRunId
const otherRunId = "run-2" as DagRunId

const counts = {
  total: 0,
  pending: 0,
  blocked: 0,
  scheduled: 0,
  running: 0,
  completed: 0,
  failed: 0,
  cancelled: 0,
  skipped: 0,
}

afterEach(() => {
  mock.restore()
  for (const root of cleanupRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function tempProject(): string {
  const directory = fs.mkdtempSync(join(tmpdir(), "senpi-dag-store-"))
  cleanupRoots.push(directory)
  return directory
}

function event(seq: number, input: Partial<DagRunEvent> = {}): DagRunEvent {
  return {
    schemaVersion: 1,
    runId,
    seq,
    at: `2026-01-01T00:00:${String(seq).padStart(2, "0")}.000Z`,
    lane: "boundary",
    type: "dag.run.started",
    generation: seq,
    ...input,
  } as DagRunEvent
}

function checkpoint(input: {
  readonly id?: DagRunId
  readonly status?: "running" | "completed"
  readonly completedAt?: string
  readonly taskId?: string
} = {}) {
  return {
    schemaVersion: 1,
    runId: input.id ?? runId,
    runKey: `key-${input.id ?? runId}`,
    parentSessionId: "parent-session",
    status: input.status ?? "running",
    ...(input.completedAt === undefined ? {} : { completedAt: input.completedAt }),
    nodes: input.taskId === undefined ? [] : [{ taskId: input.taskId }],
  }
}

describe("createDagFileStore event WAL", () => {
  test("#given five durable events #when reading two at a time #then sinceSeq is exclusive and hasMore flips", () => {
    // given
    const store = createDagFileStore({ project_dir: tempProject() })
    for (let seq = 1; seq <= 5; seq += 1) store.appendEvent(event(seq))

    // when
    const first = store.readEvents(runId, 0, { limit: 2 })
    const second = store.readEvents(runId, first.nextSinceSeq, { limit: 2 })
    const third = store.readEvents(runId, second.nextSinceSeq, { limit: 2 })

    // then
    expect(first.events.map(({ seq }) => seq)).toEqual([1, 2])
    expect(first).toMatchObject({ nextSinceSeq: 2, headSeq: 5, hasMore: true })
    expect(second.events.map(({ seq }) => seq)).toEqual([3, 4])
    expect(second).toMatchObject({ nextSinceSeq: 4, headSeq: 5, hasMore: true })
    expect(third.events.map(({ seq }) => seq)).toEqual([5])
    expect(third).toMatchObject({ nextSinceSeq: 5, headSeq: 5, hasMore: false })
  })

  test("#given mixed events beyond a catch-up boundary #when filtering a bounded page #then lane type and throughSeq all apply", () => {
    // given
    const store = createDagFileStore({ project_dir: tempProject() })
    store.appendEvent(event(1))
    store.appendEvent(event(2, { lane: "activity" }))
    store.appendEvent(event(3, { type: "dag.run.completed", counts }))
    store.appendEvent(event(4, { type: "dag.run.completed", counts }))

    // when
    const page = store.readEvents(runId, 1, {
      limit: 10,
      lane: "boundary",
      types: ["dag.run.completed"],
      throughSeq: 3,
    })

    // then
    expect(page.events.map(({ seq }) => seq)).toEqual([3])
    expect(page).toMatchObject({ nextSinceSeq: 3, headSeq: 4, hasMore: false })
  })

  test("#given one event append #when durability completes #then the WAL descriptor is fsynced", () => {
    // given
    const store = createDagFileStore({ project_dir: tempProject() })
    const fsync = spyOn(fs, "fsyncSync")

    // when
    store.appendEvent(event(1))

    // then
    expect(fsync).toHaveBeenCalledTimes(1)
  })

  test("#given a WAL ending in a torn fragment #when a new store opens #then valid events remain and the tail is diagnosed and discarded", () => {
    // given
    const project = tempProject()
    const writer = createDagFileStore({ project_dir: project })
    writer.appendEvent(event(1))
    writer.appendEvent(event(2))
    fs.appendFileSync(writer.paths.event(runId), '{"schemaVersion":1,"runId":"run-1","seq":3')

    // when
    const recovered = createDagFileStore({ project_dir: project })
    const page = recovered.readEvents(runId, 0, { limit: 10 })

    // then
    expect(page.events.map(({ seq }) => seq)).toEqual([1, 2])
    expect(recovered.diagnostics()).toEqual([
      expect.objectContaining({ kind: "event_log_recovered", runId }),
    ])
    expect(fs.readFileSync(recovered.paths.event(runId), "utf8")).toEndWith("\n")
  })

  test("#given a future-schema event file #when a store opens #then it fails closed with a journal_corrupt diagnostic", () => {
    // given
    const project = tempProject()
    const seeded = createDagFileStore({ project_dir: project })
    fs.writeFileSync(seeded.paths.event(runId), `${JSON.stringify({ ...event(1), schemaVersion: 2 })}\n`)

    // when
    const open = () => createDagFileStore({ project_dir: project })

    // then
    expect(open).toThrow(DagJournalCorruptError)
    try {
      open()
    } catch (error) {
      expect((error as DagJournalCorruptError).diagnostic).toMatchObject({
        kind: "journal_corrupt",
        runId,
      })
    }
  })
})

describe("createDagFileStore checkpoints and layout", () => {
  test("#given POSIX checkpoint persistence #when an existing checkpoint is replaced #then readers see the old complete file until rename and both file and directory are fsynced", () => {
    // given
    const options = { isProcessAlive: () => true, platform: "darwin" as const }
    const store = createDagFileStore({ project_dir: tempProject() }, options)
    fs.writeFileSync(store.paths.run(runId), JSON.stringify({ schemaVersion: 1, runId, generation: 1 }))
    const realRename = fs.renameSync
    const observedBeforeRename: unknown[] = []
    const durabilityOrder: string[] = []
    const fsync = spyOn(fs, "fsyncSync").mockImplementation(() => {
      durabilityOrder.push("fsync")
    })
    spyOn(fs, "renameSync").mockImplementation((from, to) => {
      durabilityOrder.push("rename")
      observedBeforeRename.push(JSON.parse(fs.readFileSync(to, "utf8")) as unknown)
      realRename(from, to)
    })

    // when
    store.writeCheckpoint(runId, { schemaVersion: 1, runId, generation: 2 })

    // then
    expect(observedBeforeRename).toEqual([{ schemaVersion: 1, runId, generation: 1 }])
    expect(store.readCheckpoint<{ generation: number }>(runId)?.generation).toBe(2)
    expect(fsync).toHaveBeenCalledTimes(2)
    expect(durabilityOrder).toEqual(["fsync", "rename", "fsync"])
  })

  test("#given Windows checkpoint persistence #when directory fsync would fail with EPERM #then the atomic checkpoint still succeeds", () => {
    // given
    const options = { isProcessAlive: () => true, platform: "win32" as const }
    const store = createDagFileStore({ project_dir: tempProject() }, options)
    const fsync = spyOn(fs, "fsyncSync")
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        const error = new Error("operation not permitted")
        Object.assign(error, { code: "EPERM" })
        throw error
      })

    // when
    const write = () => store.writeCheckpoint(runId, { schemaVersion: 1, runId, generation: 1 })

    // then
    expect(write).not.toThrow()
    expect(fsync).toHaveBeenCalledTimes(1)
    expect(store.readCheckpoint<{ generation: number }>(runId)?.generation).toBe(1)
  })

  test("#given a future-schema checkpoint #when it is opened #then it fails closed with a journal_corrupt diagnostic", () => {
    // given
    const store = createDagFileStore({ project_dir: tempProject() })
    fs.writeFileSync(store.paths.run(runId), JSON.stringify({ schemaVersion: 2, runId }))

    // when
    const read = () => store.readCheckpoint(runId)

    // then
    expect(read).toThrow(DagJournalCorruptError)
    try {
      read()
    } catch (error) {
      expect((error as DagJournalCorruptError).diagnostic).toMatchObject({
        kind: "journal_corrupt",
        runId,
      })
    }
  })

  test("#given a parent session and run key #when writing the key #then its filename is the exact nul-delimited sha256", () => {
    // given
    const store = createDagFileStore({ project_dir: tempProject() })
    const parentSessionId = "parent/session"
    const runKey = "release-plan"
    const expectedHash = createHash("sha256").update(`${parentSessionId}\0${runKey}`).digest("hex")

    // when
    const path = store.writeKey({ schemaVersion: 1, parentSessionId, runKey, runId })

    // then
    expect(path).toBe(join(store.paths.keys, `${expectedHash}.json`))
    expect(store.readKey(parentSessionId, runKey)?.runId).toBe(runId)
  })
})

describe("createDagFileStore locks and retention", () => {
  test("#given a lock held by a dead pid #when the run lock is acquired #then the stale lock is reclaimed", () => {
    // given
    const store = createDagFileStore(
      { project_dir: tempProject() },
      { isProcessAlive: () => false },
    )
    fs.writeFileSync(store.paths.runLock(runId), JSON.stringify({ hostPid: 2_147_483_647 }))
    let entered = false

    // when
    store.withRunLock(runId, () => {
      entered = true
      expect(fs.existsSync(store.paths.runLock(runId))).toBe(true)
    })

    // then
    expect(entered).toBe(true)
    expect(fs.existsSync(store.paths.runLock(runId))).toBe(false)
  })

  test("#given a dead holder is replaced before reclamation #when the run lock retries #then it never deletes the fresh holder", () => {
    // given
    const project = tempProject()
    let clock = 0
    const stalePid = 101
    const freshPid = 202
    let replaced = false
    const store = createDagFileStore(
      { project_dir: project },
      {
        now: () => {
          clock += 1_001
          return clock
        },
        isProcessAlive: (pid) => {
          if (pid === stalePid && !replaced) {
            replaced = true
            fs.writeFileSync(store.paths.runLock(runId), JSON.stringify({ hostPid: freshPid }))
            return false
          }
          return pid === freshPid
        },
      },
    )
    fs.writeFileSync(store.paths.runLock(runId), JSON.stringify({ hostPid: stalePid }))
    let entered = false

    // when
    const acquire = () => store.withRunLock(runId, () => { entered = true })

    // then
    expect(acquire).toThrow(`Timed out acquiring DAG lock: ${store.paths.runLock(runId)}`)
    expect(entered).toBe(false)
    expect(JSON.parse(fs.readFileSync(store.paths.runLock(runId), "utf8"))).toEqual({ hostPid: freshPid })
  })

  test("#given expired terminal artifacts and equally old live artifacts #when retention runs #then only the terminal run is pruned", () => {
    // given
    const now = Date.parse("2026-01-10T00:00:00.000Z")
    const project = tempProject()
    const store = createDagFileStore({
      project_dir: project,
      task: { dag: { retention_days: 7 } },
    })
    const old = "2026-01-01T00:00:00.000Z"
    const taskId = "st_dead-owner"
    store.writeCheckpoint(runId, checkpoint({ status: "completed", completedAt: old, taskId }))
    store.writeCheckpoint(otherRunId, checkpoint({ id: otherRunId, status: "running", completedAt: old }))
    store.appendEvent(event(1))
    store.appendEvent(event(1, { runId: otherRunId }))
    store.writeResult(runId, "node-a", "terminal result")
    store.writeResult(otherRunId, "node-a", "live result")
    const terminalKey = store.writeKey({
      schemaVersion: 1,
      parentSessionId: "parent-session",
      runKey: "key-run-1",
      runId,
    })
    const liveKey = store.writeKey({
      schemaVersion: 1,
      parentSessionId: "parent-session",
      runKey: "key-run-2",
      runId: otherRunId,
    })
    fs.writeFileSync(store.paths.runLock(runId), JSON.stringify({ hostPid: 1, runId }))
    fs.writeFileSync(store.paths.keyLock("parent-session", "key-run-1"), JSON.stringify({ hostPid: 1, runId }))
    fs.writeFileSync(store.paths.taskOwnerLock(taskId), JSON.stringify({ hostPid: 1, runId }))

    // when
    const pruned = store.pruneExpired(now)

    // then
    expect(pruned).toEqual([runId])
    expect(fs.existsSync(store.paths.run(runId))).toBe(false)
    expect(fs.existsSync(store.paths.event(runId))).toBe(false)
    expect(fs.existsSync(join(store.paths.results, runId))).toBe(false)
    expect(fs.existsSync(terminalKey)).toBe(false)
    expect(fs.existsSync(store.paths.runLock(runId))).toBe(false)
    expect(fs.existsSync(store.paths.keyLock("parent-session", "key-run-1"))).toBe(false)
    expect(fs.existsSync(store.paths.taskOwnerLock(taskId))).toBe(false)
    expect(fs.existsSync(store.paths.run(otherRunId))).toBe(true)
    expect(fs.existsSync(store.paths.event(otherRunId))).toBe(true)
    expect(fs.existsSync(join(store.paths.results, otherRunId))).toBe(true)
    expect(fs.existsSync(liveKey)).toBe(true)
  })

  test("#given expired terminal and equally old live skill sidecars #when retention runs #then only the terminal sidecar is pruned", () => {
    // given
    const now = Date.parse("2026-01-10T00:00:00.000Z")
    const old = "2026-01-01T00:00:00.000Z"
    const store = createDagFileStore({
      project_dir: tempProject(),
      task: { dag: { retention_days: 7 } },
    })
    store.writeCheckpoint(runId, checkpoint({ status: "completed", completedAt: old }))
    store.writeCheckpoint(otherRunId, checkpoint({ id: otherRunId, status: "running", completedAt: old }))
    const skillsDirectory = join(store.paths.root, "skills")
    const terminalSkills = join(skillsDirectory, `${runId}.json`)
    const liveSkills = join(skillsDirectory, `${otherRunId}.json`)
    fs.mkdirSync(skillsDirectory, { recursive: true })
    fs.writeFileSync(terminalSkills, JSON.stringify({ runId }))
    fs.writeFileSync(liveSkills, JSON.stringify({ runId: otherRunId }))

    // when
    store.pruneExpired(now)

    // then
    expect(fs.existsSync(terminalSkills)).toBe(false)
    expect(fs.existsSync(liveSkills)).toBe(true)
  })
})
