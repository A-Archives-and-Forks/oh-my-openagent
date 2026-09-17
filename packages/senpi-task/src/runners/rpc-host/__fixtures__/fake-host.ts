import { mkdtempSync, rmSync } from "node:fs"
import { createServer, type Server, type Socket } from "node:net"
import { join } from "node:path"

import type { SenpiHostProtocolInfo } from "../../../lazy/senpi-barrel"
import { fakeProtocolInfo, probeFakeHost, type FakeHostIdentityOptions } from "./fake-host-probe"

/**
 * Minimal in-process unix-socket JSONL host: enough of the senpi multi-session wire for the
 * per-child session client (protocol probe, open/close, routing tags, lifecycle records, UI
 * requests, transport loss). Todo 33 grows THIS module into the full fixture (list_sessions,
 * handoff, holdPath, stalls); keep additions behind the same `FakeHost` surface so the suites
 * written against it keep compiling.
 */
export interface FakeHostOpenFailure {
  readonly code: string
  readonly detail?: string
  readonly data?: unknown
}

export interface FakeHostOptions extends FakeHostIdentityOptions {
  readonly openFailure?: FakeHostOpenFailure
}

export interface FakeHostCommand {
  readonly type: string
  readonly sessionId: string | undefined
  readonly payload: Readonly<Record<string, unknown>>
}

export interface FakeHostSession {
  readonly routingId: string
  readonly sessionPath: string
  readonly kind: unknown
  readonly context: unknown
  readonly retainOnDisconnect: unknown
  readonly autoTitle: unknown
  readonly attachments: number
  readonly parked: boolean
}

export interface FakeHost {
  readonly socketPath: string
  readonly commands: readonly FakeHostCommand[]
  readonly connections: number
  sessions(): readonly FakeHostSession[]
  probeProtocolInfo(): Promise<SenpiHostProtocolInfo | undefined>
  failOpen(failure: FakeHostOpenFailure | undefined): void
  /** Record the named command but never answer it - the caller's request stays in flight. */
  withholdReply(type: string): void
  requestUi(routingId: string, request: Readonly<Record<string, unknown>>): void
  emitRecord(routingId: string, record: Readonly<Record<string, unknown>>): void
  evict(sessionPath: string): void
  closeSession(routingId: string, reason: string): void
  crash(): void
  waitForCommand(type: string): Promise<FakeHostCommand>
  stop(): Promise<void>
}

interface LiveSession {
  routingId: string
  readonly sessionPath: string
  readonly kind: unknown
  readonly context: unknown
  readonly retainOnDisconnect: unknown
  readonly autoTitle: unknown
  socket: Socket | undefined
  parked: boolean
}

export async function startFakeHost(options: FakeHostOptions = {}): Promise<FakeHost> {
  const dir = mkdtempSync("/tmp/dh-fake-")
  const socketPath = join(dir, "rpc.sock")
  const protocolInfo = fakeProtocolInfo(options)
  const commands: FakeHostCommand[] = []
  const waiters: Array<{ readonly type: string; readonly resolve: (command: FakeHostCommand) => void }> = []
  const sessions = new Map<string, LiveSession>()
  const sockets = new Set<Socket>()
  const withheld = new Set<string>()
  let openFailure = options.openFailure
  let nextRoutingId = 0

  const write = (socket: Socket, payload: unknown): void => {
    socket.write(`${JSON.stringify(payload)}\n`)
  }

  const record = (command: FakeHostCommand): void => {
    commands.push(command)
    for (let index = waiters.length - 1; index >= 0; index--) {
      const waiter = waiters[index]
      if (waiter === undefined || waiter.type !== command.type) continue
      waiters.splice(index, 1)
      waiter.resolve(command)
    }
  }

  const findByRouting = (routingId: string): LiveSession | undefined =>
    [...sessions.values()].find((session) => session.routingId === routingId)

  const openSession = (socket: Socket, payload: Readonly<Record<string, unknown>>): void => {
    if (openFailure !== undefined) {
      const failure = openFailure
      write(socket, {
        type: "response",
        id: payload.id,
        command: "open_session",
        success: false,
        error: `${failure.code}${failure.detail === undefined ? "" : `: ${failure.detail}`}`,
        errorCode: failure.code,
        ...(failure.data === undefined ? {} : { errorData: failure.data }),
      })
      return
    }
    const existing = typeof payload.sessionPath === "string" ? sessions.get(payload.sessionPath) : undefined
    const session: LiveSession = existing ?? {
      routingId: "",
      sessionPath: String(payload.sessionPath ?? `unnamed-${nextRoutingId}`),
      kind: payload.kind,
      context: payload.context,
      retainOnDisconnect: payload.retain_on_disconnect,
      autoTitle: payload.auto_title,
      socket,
      parked: false,
    }
    session.routingId = `routing-${++nextRoutingId}`
    session.socket = socket
    session.parked = false
    sessions.set(session.sessionPath, session)
    write(socket, {
      type: "response",
      id: payload.id,
      command: "open_session",
      success: true,
      sessionId: session.routingId,
      data: {
        sessionId: session.routingId,
        state: { sessionId: `durable-${session.routingId}` },
        attached: existing !== undefined,
      },
    })
  }

  const handleLine = (socket: Socket, line: string): void => {
    const parsed: unknown = JSON.parse(line)
    if (typeof parsed !== "object" || parsed === null) return
    const payload: Readonly<Record<string, unknown>> = { ...parsed }
    const type = typeof payload.type === "string" ? payload.type : "unknown"
    record({ type, sessionId: typeof payload.sessionId === "string" ? payload.sessionId : undefined, payload })
    if (withheld.has(type)) return
    const ok = (data: unknown): void => write(socket, { type: "response", id: payload.id, command: type, success: true, data })
    switch (type) {
      case "get_protocol_info":
        return write(socket, { type: "response", id: payload.id, command: type, success: true, data: protocolInfo })
      case "open_session":
        return openSession(socket, payload)
      case "close_session": {
        const routingId = typeof payload.sessionId === "string" ? payload.sessionId : ""
        const session = findByRouting(routingId)
        if (session !== undefined) sessions.delete(session.sessionPath)
        ok({})
        return write(socket, { type: "session_closed", sessionId: routingId, reason: "client_close" })
      }
      case "get_state":
        return ok({ sessionId: `durable-${payload.sessionId}` })
      case "get_entries":
        return ok({ entries: [], leafId: null })
      case "switch_session":
        return ok({ cancelled: false })
      case "extension_ui_response":
      case "extension_ui_progress":
        return
      default:
        return ok({})
    }
  }

  const server: Server = createServer((socket) => {
    sockets.add(socket)
    let buffer = ""
    socket.setEncoding("utf8")
    socket.on("data", (chunk: string) => {
      buffer += chunk
      for (;;) {
        const newline = buffer.indexOf("\n")
        if (newline === -1) break
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line) handleLine(socket, line)
      }
    })
    socket.on("error", () => undefined)
    socket.on("close", () => {
      sockets.delete(socket)
      for (const [path, session] of sessions) {
        if (session.socket !== socket) continue
        session.socket = undefined
        if (session.retainOnDisconnect !== true) sessions.delete(path)
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))

  // The routing tag goes FIRST so a payload may carry a foreign `sessionId` on purpose - that is
  // how a suite proves a client drops records addressed to another session.
  const sendTo = (routingId: string, payload: Readonly<Record<string, unknown>>): void => {
    const session = findByRouting(routingId)
    if (session?.socket !== undefined) write(session.socket, { sessionId: routingId, ...payload })
  }

  return {
    socketPath,
    commands,
    get connections() {
      return sockets.size
    },
    sessions: () =>
      [...sessions.values()].map((session) => ({
        routingId: session.routingId,
        sessionPath: session.sessionPath,
        kind: session.kind,
        context: session.context,
        retainOnDisconnect: session.retainOnDisconnect,
        autoTitle: session.autoTitle,
        attachments: session.socket === undefined ? 0 : 1,
        parked: session.parked,
      })),
    probeProtocolInfo: () => probeFakeHost(socketPath),
    failOpen: (failure) => {
      openFailure = failure
    },
    withholdReply: (type) => {
      withheld.add(type)
    },
    requestUi: (routingId, request) => sendTo(routingId, { type: "extension_ui_request", ...request }),
    emitRecord: (routingId, payload) => sendTo(routingId, payload),
    evict: (sessionPath) => {
      const session = sessions.get(sessionPath)
      if (session === undefined) return
      sendTo(session.routingId, { type: "session_parked", sessionPath })
      session.parked = true
      session.socket = undefined
    },
    closeSession: (routingId, reason) => {
      const session = findByRouting(routingId)
      sendTo(routingId, { type: "session_closed", reason })
      if (session !== undefined) sessions.delete(session.sessionPath)
    },
    crash: () => {
      for (const socket of [...sockets]) socket.destroy()
    },
    waitForCommand: (type) =>
      new Promise<FakeHostCommand>((resolve) => {
        waiters.push({ type, resolve })
      }),
    stop: async () => {
      for (const socket of [...sockets]) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
