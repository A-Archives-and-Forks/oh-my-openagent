import type { ChildProcess } from "node:child_process"
import type { RpcResponse, RpcSessionState } from "@code-yeongyu/senpi"
import { log } from "@oh-my-opencode/utils"

import type {
  ChildEventListener,
  ChildExitOutcome,
  RpcChildHandle,
  RpcTerminalAssistantMessage,
  TerminateOptions,
} from "../types"
import { RpcCommandError } from "./errors"
import { classifyChildExit } from "./exit-mapping"
import type { RpcProtocolClient } from "./protocol-client"
import { terminateRpcChild } from "./terminate"

export type CreateRpcChildHandleOptions = {
  readonly client: RpcProtocolClient
  readonly child: ChildProcess
  readonly taskId: string
  readonly heartbeatIntervalMs: number
  readonly now: () => number
}

/**
 * Assemble the steerable RpcChildHandle over a protocol client: steer/followUp/
 * abort mapping, event fan-out, idle + exit awaiting, final-text tracking, and
 * a get_state liveness heartbeat (records lastSeen only). terminate() delegates
 * to the single-writer terminate module.
 */
export function createRpcChildHandle(options: CreateRpcChildHandleOptions): RpcChildHandle {
  const { client, child, taskId, heartbeatIntervalMs, now } = options
  const idleWaiters: Array<() => void> = []
  const exitWaiters: Array<(outcome: ChildExitOutcome) => void> = []
  let reachedIdle = false
  let sessionId: string | undefined
  let finalText: string | undefined
  let terminalAssistantMessage: RpcTerminalAssistantMessage | undefined
  let abortedByUser = false
  let lastSeenAt: number | undefined
  let outcome: ChildExitOutcome | undefined

  client.onEvent((event) => {
    if (event.type === "message_end") {
      const terminal = extractTerminalAssistantMessage(event.message)
      if (terminal !== undefined) {
        terminalAssistantMessage = terminal
        finalText = terminal.text ?? finalText
      }
    }
    if (event.type === "agent_end" && event.willRetry === false) {
      reachedIdle = true
      flush(idleWaiters)
    }
  })

  const heartbeat = setInterval(() => {
    client
      .send({ type: "get_state" })
      .then((response) => {
        lastSeenAt = now()
        sessionId = readSessionId(response) ?? sessionId
      })
      .catch((error: unknown) => log("senpi-task heartbeat get_state failed", { taskId, error: String(error) }))
  }, heartbeatIntervalMs)
  heartbeat.unref?.()

  const settleExit = (built: ChildExitOutcome): void => {
    if (outcome) {
      return
    }
    outcome = built
    clearInterval(heartbeat)
    flush(idleWaiters)
    for (const waiter of exitWaiters.splice(0)) {
      waiter(built)
    }
  }

  child.once("error", (error) => settleExit(classifyChildExit({ code: null, signal: null, error, pid: child.pid, stderr: client.stderrTail })))
  child.once("exit", (code, signal) => settleExit(classifyChildExit({ code, signal, pid: child.pid, stderr: client.stderrTail })))

  const runCommand = async (command: Parameters<RpcProtocolClient["send"]>[0], label: string): Promise<void> => {
    const response = await client.send(command)
    assertOk(response, label)
  }

  // Reviving an idle resident child starts a fresh turn. Clear per-turn facts BEFORE sending the
  // prompt so an immediately emitted event cannot race with a post-command reset. Keep finalText as
  // the cross-turn partial-output surface; the classifier reads only terminalAssistantMessage.
  const prepareIdleRevive = (): (() => void) | undefined => {
    if (!reachedIdle || outcome !== undefined) return undefined
    const previousTerminal = terminalAssistantMessage
    const previousAbortedByUser = abortedByUser
    reachedIdle = false
    terminalAssistantMessage = undefined
    abortedByUser = false
    return () => {
      reachedIdle = true
      terminalAssistantMessage = previousTerminal
      abortedByUser = previousAbortedByUser
    }
  }

  return {
    task_id: taskId,
    get sessionId() {
      return sessionId
    },
    get pid() {
      return child.pid ?? undefined
    },
    steer: (text) => runCommand({ type: "steer", message: text }, "steer"),
    followUp: async (text) => {
      const restore = prepareIdleRevive()
      try {
        await runCommand({ type: "prompt", message: text, streamingBehavior: "followUp" }, "prompt")
      } catch (error) {
        restore?.()
        throw error
      }
    },
    abort: () => {
      abortedByUser = true
      return runCommand({ type: "abort" }, "abort")
    },
    subscribe: (listener: ChildEventListener) => client.onEvent(listener),
    waitForIdle: () =>
      reachedIdle || outcome ? Promise.resolve() : new Promise<void>((resolve) => idleWaiters.push(resolve)),
    lastAssistantText: () => finalText,
    terminalAssistantMessage: () => terminalAssistantMessage,
    wasAbortedByUser: () => abortedByUser,
    lastSeen: () => lastSeenAt,
    exitOutcome: () => outcome,
    waitForExit: () => (outcome ? Promise.resolve(outcome) : new Promise<ChildExitOutcome>((resolve) => exitWaiters.push(resolve))),
    dispose: () => {
      clearInterval(heartbeat)
      client.detach()
      return Promise.resolve()
    },
    terminate: (terminateOptions?: TerminateOptions) => terminateRpcChild(child, terminateOptions),
  }
}

function flush(waiters: Array<() => void>): void {
  for (const waiter of waiters.splice(0)) {
    waiter()
  }
}

function assertOk(response: RpcResponse, label: string): void {
  if (!response.success) {
    throw new RpcCommandError(label, response.error)
  }
}

function readSessionId(response: RpcResponse): string | undefined {
  if (response.command !== "get_state" || !response.success) {
    return undefined
  }
  const state: RpcSessionState = response.data
  return state.sessionId
}

function extractTerminalAssistantMessage(message: unknown): RpcTerminalAssistantMessage | undefined {
  if (!isRecord(message) || message.role !== "assistant") return undefined
  const text = extractAssistantText(message)
  const stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined
  const errorMessage = typeof message.errorMessage === "string" ? message.errorMessage : undefined
  return {
    ...(text === undefined ? {} : { text }),
    ...(stopReason === undefined ? {} : { stopReason }),
    ...(errorMessage === undefined ? {} : { errorMessage }),
  }
}

function extractAssistantText(message: Record<string, unknown>): string | undefined {
  if (!Array.isArray(message.content)) return undefined
  const text = message.content
    .filter((part: unknown): part is { type: "text"; text: string } => isTextPart(part))
    .map((part) => part.text)
    .join("")
  return text.length > 0 ? text : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isTextPart(part: unknown): part is { type: "text"; text: string } {
  return isRecord(part) && part.type === "text" && typeof part.text === "string"
}
