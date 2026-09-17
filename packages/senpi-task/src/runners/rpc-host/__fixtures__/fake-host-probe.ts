import { connect } from "node:net"

import type { SenpiHostProtocolInfo } from "../../../lazy/senpi-barrel"

/**
 * The fake daemon's identity half: what it answers `get_protocol_info` with, and the out-of-band
 * probe a client makes against it (one short-lived connection, one line, one answer).
 */

export const FAKE_HOST_CAPABILITIES = [
  "multi_session",
  "extension_events",
  "session_context",
  "session_kind",
  "retain_on_disconnect",
  "auto_title_per_session",
  "generation_handoff",
] as const

export interface FakeHostIdentityOptions {
  readonly capabilities?: readonly string[]
  readonly protocolVersion?: number
  readonly instanceId?: string
  readonly engineVersion?: string
}

export function fakeProtocolInfo(options: FakeHostIdentityOptions): Readonly<Record<string, unknown>> {
  const engineVersion = options.engineVersion ?? "2026.9.18"
  return {
    protocolVersion: options.protocolVersion ?? 1,
    serverVersion: engineVersion,
    instanceId: options.instanceId ?? "fake-instance",
    generation: 1,
    engineVersion,
    engineOrdinal: [2026, 9, 18, 0, 0],
    capabilities: [...(options.capabilities ?? FAKE_HOST_CAPABILITIES)],
    launch_profile: { profile_id: "fake-profile" },
  }
}

export async function probeFakeHost(socketPath: string): Promise<SenpiHostProtocolInfo | undefined> {
  return new Promise<SenpiHostProtocolInfo | undefined>((resolve) => {
    const socket = connect(socketPath)
    let buffer = ""
    const finish = (info: SenpiHostProtocolInfo | undefined): void => {
      socket.destroy()
      resolve(info)
    }
    socket.setEncoding("utf8")
    socket.on("connect", () => socket.write('{"id":"fake-probe","type":"get_protocol_info"}\n'))
    socket.on("data", (chunk: string) => {
      buffer += chunk
      const newline = buffer.indexOf("\n")
      if (newline !== -1) finish(readProtocolInfo(buffer.slice(0, newline)))
    })
    socket.on("error", () => finish(undefined))
  })
}

function readProtocolInfo(line: string): SenpiHostProtocolInfo | undefined {
  const parsed: unknown = JSON.parse(line)
  if (typeof parsed !== "object" || parsed === null || !("data" in parsed)) return undefined
  const data = parsed.data
  if (typeof data !== "object" || data === null) return undefined
  const info: Readonly<Record<string, unknown>> = { ...data }
  const capabilities = info.capabilities
  if (typeof info.instanceId !== "string" || typeof info.engineVersion !== "string") return undefined
  if (typeof info.protocolVersion !== "number" || !Array.isArray(capabilities)) return undefined
  return {
    protocolVersion: info.protocolVersion,
    instanceId: info.instanceId,
    generation: typeof info.generation === "number" ? info.generation : 0,
    engineVersion: info.engineVersion,
    engineOrdinal: Array.isArray(info.engineOrdinal) ? info.engineOrdinal.map(Number) : [],
    capabilities: capabilities.map(String),
  }
}
