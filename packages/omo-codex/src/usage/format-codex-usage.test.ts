/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test"
import { formatCodexUsage, formatCodexUsageJson } from "./format-codex-usage"
import type { CodexUsageReport } from "./types"

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
    {
      id: "codex_bengalfox",
      label: "Spark",
      planType: "pro",
      primary: {
        usedPercent: 0,
        remainingPercent: 100,
        windowDurationMins: 300,
        resetsAt: "2026-08-30T17:40:46.000Z",
      },
      secondary: {
        usedPercent: 0,
        remainingPercent: 100,
        windowDurationMins: 10080,
        resetsAt: "2026-09-06T12:40:46.000Z",
      },
      credits: null,
      rateLimitReachedType: null,
    },
  ],
  resetCredits: {
    availableCount: 1,
  },
}

describe("Codex usage formatting", () => {
  test("#given a normalized report #when formatted for humans #then shows plan meters resets credits and availability", () => {
    // when
    const output = formatCodexUsage(report)

    // then
    expect(output).toBe([
      "OpenAI Codex Usage",
      "Plan: Pro",
      "Authentication: ChatGPT",
      "",
      "Codex",
      "  7 days: 8% used, 92% remaining",
      "  Resets: 2026-09-06T02:51:20.000Z",
      "  Credits: none",
      "",
      "Spark",
      "  5 hours: 0% used, 100% remaining",
      "  Resets: 2026-08-30T17:40:46.000Z",
      "  7 days: 0% used, 100% remaining",
      "  Resets: 2026-09-06T12:40:46.000Z",
      "",
      "Saved resets: 1",
      "Status: available",
    ].join("\n"))
  })

  test("#given a normalized report #when formatted as JSON #then preserves machine-consumed quota fields", () => {
    // when
    const output = JSON.parse(formatCodexUsageJson(report))

    // then
    expect(output.planType).toBe("pro")
    expect(output.limits[0].primary.remainingPercent).toBe(92)
    expect(output.limits[1].id).toBe("codex_bengalfox")
    expect(output.resetCredits.availableCount).toBe(1)
  })
})
