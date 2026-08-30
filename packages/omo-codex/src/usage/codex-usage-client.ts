import {
  createCodexUsageTransport,
  type CodexUsageProtocolMessage,
  type CodexUsageTransport,
} from "./codex-usage-transport"
import { parseCodexUsageResponses } from "./parse-codex-usage"
import type { CodexUsageReport } from "./types"

export { createCodexUsageTransport }
export type { CodexUsageProtocolMessage, CodexUsageTransport }

export type FetchCodexUsageOptions = {
  readonly createTransport?: () => CodexUsageTransport
  readonly now?: () => Date
  readonly timeoutMs?: number
}

const INITIALIZE_ID = 1
const ACCOUNT_READ_ID = 2
const RATE_LIMITS_READ_ID = 3
const DEFAULT_TIMEOUT_MS = 10_000

export function fetchCodexUsage(options: FetchCodexUsageOptions = {}): Promise<CodexUsageReport> {
  const createTransport = options.createTransport ?? createCodexUsageTransport
  const now = options.now ?? (() => new Date())
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return new Promise((resolve, reject) => {
    const transport = createTransport()
    let settled = false
    let initialized = false
    let accountResponse: unknown
    let rateLimitsResponse: unknown

    const timer = setTimeout(() => {
      fail(new Error(`Codex usage request timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    function finish(report: CodexUsageReport): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      transport.close()
      resolve(report)
    }

    function fail(error: Error): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      transport.close()
      reject(error)
    }

    function tryFinish(): void {
      if (accountResponse === undefined || rateLimitsResponse === undefined) return
      try {
        finish(parseCodexUsageResponses(accountResponse, rateLimitsResponse, now()))
      } catch (error) {
        fail(toError(error))
      }
    }

    transport.onMessage((message) => {
      if (message.id === INITIALIZE_ID) {
        if (message.error !== undefined) {
          fail(protocolError("Codex app-server initialization failed", message.error))
          return
        }
        if (initialized) return
        initialized = true
        transport.send({ method: "initialized" })
        transport.send({
          id: ACCOUNT_READ_ID,
          method: "account/read",
          params: { refreshToken: false },
        })
        transport.send({
          id: RATE_LIMITS_READ_ID,
          method: "account/rateLimits/read",
          params: {},
        })
        return
      }

      if (message.id === ACCOUNT_READ_ID) {
        if (message.error !== undefined) {
          fail(protocolError("Codex account request failed", message.error))
          return
        }
        accountResponse = message.result
        tryFinish()
        return
      }

      if (message.id === RATE_LIMITS_READ_ID) {
        if (message.error !== undefined) {
          fail(protocolError("Codex usage request failed", message.error))
          return
        }
        rateLimitsResponse = message.result
        tryFinish()
      }
    })
    transport.onError((error) => {
      const message =
        "code" in error && error.code === "ENOENT"
          ? "Codex CLI was not found. Install Codex or add it to PATH."
          : `Codex app-server failed: ${error.message}`
      fail(new Error(message))
    })
    transport.onExit((code) => {
      fail(new Error(`Codex app-server exited before returning usage${code === null ? "" : ` (code ${code})`}`))
    })

    transport.send({
      id: INITIALIZE_ID,
      method: "initialize",
      params: {
        clientInfo: {
          name: "oh-my-openagent",
          title: "oh-my-openagent",
          version: "1.0.0",
        },
      },
    })
  })
}

function protocolError(prefix: string, error: { readonly message: string }): Error {
  return new Error(`${prefix}: ${error.message}`)
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
