/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test"
import {
  fetchCodexUsage,
  type CodexUsageProtocolMessage,
  type CodexUsageTransport,
} from "./codex-usage-client"

class FakeTransport implements CodexUsageTransport {
  readonly sent: CodexUsageProtocolMessage[] = []
  closed = false
  private messageListener: ((message: CodexUsageProtocolMessage) => void) | undefined
  private errorListener: ((error: Error) => void) | undefined
  private exitListener: ((code: number | null) => void) | undefined

  constructor(
    private readonly respond: (message: CodexUsageProtocolMessage) => readonly CodexUsageProtocolMessage[],
  ) {}

  send(message: CodexUsageProtocolMessage): void {
    this.sent.push(message)
    for (const response of this.respond(message)) {
      queueMicrotask(() => this.messageListener?.(response))
    }
  }

  onMessage(listener: (message: CodexUsageProtocolMessage) => void): void {
    this.messageListener = listener
  }

  onError(listener: (error: Error) => void): void {
    this.errorListener = listener
  }

  onExit(listener: (code: number | null) => void): void {
    this.exitListener = listener
  }

  close(): void {
    this.closed = true
  }

  emitError(error: Error): void {
    this.errorListener?.(error)
  }

  emitExit(code: number | null): void {
    this.exitListener?.(code)
  }
}

function successfulResponse(message: CodexUsageProtocolMessage): readonly CodexUsageProtocolMessage[] {
  if (message.method === "initialize") {
    return [{ id: message.id, result: { userAgent: "codex-cli" } }]
  }
  if (message.method === "account/read") {
    return [{ id: message.id, result: { account: { type: "chatgpt" } } }]
  }
  if (message.method === "account/rateLimits/read") {
    return [
      {
        id: message.id,
        result: {
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
          rateLimitResetCredits: {
            availableCount: 1,
          },
        },
      },
    ]
  }
  return []
}

describe("Codex usage app-server client", () => {
  test("#given a responding transport #when usage is fetched #then performs the handshake and closes after both reads", async () => {
    // given
    const transport = new FakeTransport(successfulResponse)

    // when
    const report = await fetchCodexUsage({
      createTransport: () => transport,
      now: () => new Date("2026-08-30T16:00:00.000Z"),
    })

    // then
    expect(transport.sent.map((message) => message.method)).toEqual([
      "initialize",
      "initialized",
      "account/read",
      "account/rateLimits/read",
    ])
    expect(report.planType).toBe("pro")
    expect(report.limits[0]?.primary?.remainingPercent).toBe(92)
    expect(transport.closed).toBe(true)
  })

  test("#given a rate-limit request error #when usage is fetched #then returns an actionable failure and closes", async () => {
    // given
    const transport = new FakeTransport((message) => {
      if (message.method === "account/rateLimits/read") {
        return [{ id: message.id, error: { code: -32000, message: "not logged in" } }]
      }
      return successfulResponse(message)
    })

    // when
    const fetch = fetchCodexUsage({
      createTransport: () => transport,
      now: () => new Date("2026-08-30T16:00:00.000Z"),
    })

    // then
    await expect(fetch).rejects.toThrow("Codex usage request failed: not logged in")
    expect(transport.closed).toBe(true)
  })
})
