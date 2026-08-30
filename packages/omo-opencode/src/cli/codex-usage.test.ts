/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test"
import type { CodexUsageReport } from "@oh-my-opencode/omo-codex"
import { codexUsage } from "./codex-usage"

const report: CodexUsageReport = {
  fetchedAt: "2026-08-30T16:00:00.000Z",
  authType: "chatgpt",
  planType: "pro",
  limits: [
    {
      id: "codex",
      label: "Codex",
      planType: "pro",
      primary: {
        usedPercent: 8,
        remainingPercent: 92,
        windowDurationMins: 10080,
        resetsAt: "2026-09-06T02:51:20.000Z",
      },
      secondary: null,
      credits: {
        hasCredits: false,
        unlimited: false,
        balance: "0",
      },
      rateLimitReachedType: null,
    },
  ],
  resetCredits: {
    availableCount: 1,
  },
}

describe("Codex usage command", () => {
  test("#given JSON output requested #when usage loads #then writes a machine-readable report", async () => {
    // given
    const stdout: string[] = []
    const stderr: string[] = []

    // when
    const exitCode = await codexUsage(
      { json: true },
      {
        fetchUsage: async () => report,
        writeStdout: (value) => stdout.push(value),
        writeStderr: (value) => stderr.push(value),
      },
    )

    // then
    expect(exitCode).toBe(0)
    expect(stderr).toEqual([])
    expect(JSON.parse(stdout.join("")).limits[0].primary.remainingPercent).toBe(92)
  })

  test("#given app-server failure #when text output is requested #then writes an actionable error and fails", async () => {
    // given
    const stdout: string[] = []
    const stderr: string[] = []

    // when
    const exitCode = await codexUsage(
      { json: false },
      {
        fetchUsage: async () => {
          throw new Error("Codex usage request failed: not logged in")
        },
        writeStdout: (value) => stdout.push(value),
        writeStderr: (value) => stderr.push(value),
      },
    )

    // then
    expect(exitCode).toBe(1)
    expect(stdout).toEqual([])
    expect(stderr.join("")).toBe("Codex usage unavailable: Codex usage request failed: not logged in\n")
  })

  test("#given app-server failure #when JSON output is requested #then writes a structured error to stdout", async () => {
    // given
    const stdout: string[] = []

    // when
    const exitCode = await codexUsage(
      { json: true },
      {
        fetchUsage: async () => {
          throw new Error("Codex CLI was not found")
        },
        writeStdout: (value) => stdout.push(value),
        writeStderr: () => undefined,
      },
    )

    // then
    expect(exitCode).toBe(1)
    expect(JSON.parse(stdout.join(""))).toEqual({
      ok: false,
      error: "Codex CLI was not found",
    })
  })
})
