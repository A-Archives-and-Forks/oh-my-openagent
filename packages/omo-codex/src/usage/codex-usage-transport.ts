import { spawn } from "node:child_process"

export type CodexUsageProtocolMessage = {
  readonly id?: number
  readonly method?: string
  readonly params?: unknown
  readonly result?: unknown
  readonly error?: {
    readonly code?: number
    readonly message: string
  }
}

export type CodexUsageTransport = {
  send(message: CodexUsageProtocolMessage): void
  onMessage(listener: (message: CodexUsageProtocolMessage) => void): void
  onError(listener: (error: Error) => void): void
  onExit(listener: (code: number | null) => void): void
  close(): void
}

export function createCodexUsageTransport(): CodexUsageTransport {
  const child = spawn("codex", ["app-server", "--stdio"], {
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  })
  let buffer = ""
  let messageListener: ((message: CodexUsageProtocolMessage) => void) | undefined
  let errorListener: ((error: Error) => void) | undefined
  let exitListener: ((code: number | null) => void) | undefined

  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8")
    while (true) {
      const newline = buffer.indexOf("\n")
      if (newline < 0) return
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line.length === 0) continue
      try {
        messageListener?.(parseProtocolMessage(line))
      } catch (error) {
        errorListener?.(toError(error))
      }
    }
  })
  child.on("error", (error) => errorListener?.(error))
  child.on("exit", (code) => exitListener?.(code))

  return {
    send(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`)
    },
    onMessage(listener) {
      messageListener = listener
    },
    onError(listener) {
      errorListener = listener
    },
    onExit(listener) {
      exitListener = listener
    },
    close() {
      child.stdin.end()
      child.kill()
    },
  }
}

function parseProtocolMessage(line: string): CodexUsageProtocolMessage {
  const value: unknown = JSON.parse(line)
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Codex app-server returned a malformed protocol message")
  }
  return Object.fromEntries(Object.entries(value))
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
