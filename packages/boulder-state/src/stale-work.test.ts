/// <reference path="../../../bun-test.d.ts" />

import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

import { readBoulderState, reconcileStaleWorks } from "./index"

const STALE_WORK_ID = "omo-agent-toolkit-eval-sdk-20260913"
const STALE_SESSION_ID = "senpi:01a09988-f0b5-7e7c-97b2-ea591aa4bdaf"
const STALE_TRANSCRIPT_FILE = "2026-09-13T06-51-23-701Z_01a09988-f0b5-7e7c-97b2-ea591aa4bdaf.jsonl"
const HOUR_MS = 60 * 60 * 1000

// The record observed in a real install: no `updated_at`, no `started_at`, and extra fields the
// ulw-execute writer keeps beside the tracked ones.
function createStaleWorkRecord(): Record<string, unknown> {
  return {
    work_id: STALE_WORK_ID,
    active_plan: ".omo/plans/omo-agent-toolkit-eval-sdk.md",
    plan_name: "omo-agent-toolkit-eval-sdk",
    session_ids: [STALE_SESSION_ID],
    status: "active",
    worktree_path: null,
    ulw_loop_session: "01a09988-f0b5-7e7c-97b2-ea591aa4bdaf",
    mode: "--ship",
  }
}

function createProject(works: Record<string, unknown>, activeWorkId: string): string {
  const directory = mkdtempSync(join(tmpdir(), "boulder-stale-work-"))
  const boulderDirectory = join(directory, ".omo")
  mkdirSync(boulderDirectory, { recursive: true })
  const activeWork = works[activeWorkId] as Record<string, unknown>
  writeFileSync(
    join(boulderDirectory, "boulder.json"),
    JSON.stringify({
      schema_version: 2,
      active_work_id: activeWorkId,
      works,
      active_plan: activeWork["active_plan"],
      plan_name: activeWork["plan_name"],
      status: activeWork["status"],
      session_ids: activeWork["session_ids"],
    }),
    "utf-8",
  )
  return directory
}

// Senpi keeps transcripts at <agentDir>/sessions/<encoded session cwd>/<timestamp>_<sessionId>.jsonl.
function writeTranscript(input: { projectDirectory: string; fileName: string; mtimeMs: number }): string {
  const sessionsDirectory = mkdtempSync(join(tmpdir(), "boulder-stale-agent-"))
  const projectSessionsDirectory = join(
    sessionsDirectory,
    `--${input.projectDirectory.split("/").filter((segment) => segment.length > 0).join("-")}--`,
  )
  mkdirSync(projectSessionsDirectory, { recursive: true })
  const transcriptPath = join(projectSessionsDirectory, input.fileName)
  writeFileSync(transcriptPath, `${JSON.stringify({ type: "session", id: "01a09988-f0b5-7e7c-97b2-ea591aa4bdaf" })}\n`, "utf-8")
  const mtime = new Date(input.mtimeMs)
  utimesSync(transcriptPath, mtime, mtime)
  return sessionsDirectory
}

describe("reconcileStaleWorks", () => {
  test("#given an active work whose only session transcript is 41 hours old #when reconciling #then the work is paused and stamped", () => {
    // given
    const nowMs = Date.parse("2026-09-17T06:00:00.000Z")
    const directory = createProject({ [STALE_WORK_ID]: createStaleWorkRecord() }, STALE_WORK_ID)
    const sessionsDirectory = writeTranscript({
      projectDirectory: directory,
      fileName: STALE_TRANSCRIPT_FILE,
      mtimeMs: nowMs - 41 * HOUR_MS,
    })

    // when
    const result = reconcileStaleWorks(directory, { sessionsDirectory, now: nowMs })

    // then
    expect(result.demoted.map((demotion) => demotion.work_id)).toEqual([STALE_WORK_ID])
    const work = readBoulderState(directory)?.works?.[STALE_WORK_ID]
    expect(work?.status).toBe("paused")
    expect(work?.stale_since).toBe(new Date(nowMs).toISOString())
    expect(work?.session_ids).toEqual([STALE_SESSION_ID])
  })
})
