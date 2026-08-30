/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test"
import { parseCodexUsageResponses } from "./parse-codex-usage"

describe("Codex usage response parsing", () => {
  test("#given account and multi-meter rate limits #when parsed #then normalizes plan windows credits and saved resets", () => {
    // given
    const accountResponse = {
      account: {
        type: "chatgpt",
        email: "private@example.com",
      },
    }
    const rateLimitsResponse = {
      rateLimits: {
        limitId: "codex",
        primary: {
          usedPercent: 8,
          windowDurationMins: 10080,
          resetsAt: 1788663080,
        },
        secondary: null,
        credits: {
          hasCredits: false,
          unlimited: false,
          balance: "0",
        },
        planType: "pro",
        rateLimitReachedType: null,
      },
      rateLimitsByLimitId: {
        codex_bengalfox: {
          limitId: "codex_bengalfox",
          primary: {
            usedPercent: 0,
            windowDurationMins: 300,
            resetsAt: 1788111646,
          },
          secondary: {
            usedPercent: 0,
            windowDurationMins: 10080,
            resetsAt: 1788698446,
          },
          planType: "pro",
          rateLimitReachedType: null,
        },
        codex: {
          limitId: "codex",
          primary: {
            usedPercent: 8,
            windowDurationMins: 10080,
            resetsAt: 1788663080,
          },
          secondary: null,
          credits: {
            hasCredits: false,
            unlimited: false,
            balance: "0",
          },
          planType: "pro",
          rateLimitReachedType: null,
        },
      },
      rateLimitResetCredits: {
        availableCount: 1,
      },
    }

    // when
    const report = parseCodexUsageResponses(
      accountResponse,
      rateLimitsResponse,
      new Date("2026-08-30T16:00:00.000Z"),
    )

    // then
    expect(report).toEqual({
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
    })
    expect(JSON.stringify(report)).not.toContain("private@example.com")
  })

  test("#given a malformed rate-limit payload #when parsed #then rejects it instead of inventing empty usage", () => {
    // given
    const malformedResponse = {
      rateLimits: {
        planType: "pro",
        primary: {
          usedPercent: "eight",
        },
      },
    }

    // when
    const parse = () => parseCodexUsageResponses({ account: { type: "chatgpt" } }, malformedResponse)

    // then
    expect(parse).toThrow("Codex app-server returned no valid usage limits")
  })
})
