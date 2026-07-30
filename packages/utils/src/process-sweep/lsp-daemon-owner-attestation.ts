import { readFile } from "node:fs/promises"
import { createConnection } from "node:net"

export interface LspDaemonOwnerEndpoint {
  readonly dev: number
  readonly ino: number
  readonly kind: "unix"
  readonly path: string
}

export interface LspDaemonOwnerIdentity {
  readonly endpoint: LspDaemonOwnerEndpoint
  readonly nonce: string
  readonly pid: number
  readonly startedAt: string
}

export interface LspDaemonOwnerTarget {
  readonly authPath: string
  readonly owner: LspDaemonOwnerIdentity
  readonly ownerPath: string
  readonly pid: number
}

export interface LspDaemonOwnerAttestationDeps {
  readonly pingOwner?: (endpoint: LspDaemonOwnerEndpoint, authToken: string) => Promise<LspDaemonOwnerIdentity | null>
  readonly readText?: (path: string) => Promise<string>
}

export async function attestLspDaemonOwner(
  target: LspDaemonOwnerTarget,
  deps: LspDaemonOwnerAttestationDeps = {},
): Promise<boolean> {
  try {
    const readText = deps.readText ?? ((path: string) => readFile(path, "utf8"))
    const currentOwner = parseLspDaemonOwner(JSON.parse(await readText(target.ownerPath)))
    if (currentOwner === null || !sameOwner(currentOwner, target.owner)) return false
    const authToken = (await readText(target.authPath)).trim()
    if (authToken.length === 0) return false
    const pingOwner = deps.pingOwner ?? pingLspDaemonOwner
    const liveOwner = await pingOwner(target.owner.endpoint, authToken)
    return liveOwner !== null && sameOwner(liveOwner, target.owner)
  } catch {
    return false
  }
}

export function parseLspDaemonOwner(value: unknown): LspDaemonOwnerIdentity | null {
  if (!isRecord(value)) return null
  const { endpoint, nonce, pid, startedAt } = value
  if (!Number.isSafeInteger(pid) || (pid as number) <= 0) return null
  if (typeof nonce !== "string" || nonce.length === 0) return null
  if (typeof startedAt !== "string" || startedAt.length === 0) return null
  if (!isRecord(endpoint)) return null
  if (endpoint.kind !== "unix" || typeof endpoint.path !== "string" || endpoint.path.length === 0) return null
  if (!Number.isSafeInteger(endpoint.dev) || !Number.isSafeInteger(endpoint.ino)) return null
  return {
    endpoint: { dev: endpoint.dev as number, ino: endpoint.ino as number, kind: "unix", path: endpoint.path },
    nonce,
    pid: pid as number,
    startedAt,
  }
}

async function pingLspDaemonOwner(
  endpoint: LspDaemonOwnerEndpoint,
  authToken: string,
): Promise<LspDaemonOwnerIdentity | null> {
  return new Promise((resolvePromise) => {
    let buffer = ""
    let settled = false
    const socket = createConnection(endpoint.path)
    const finish = (owner: LspDaemonOwnerIdentity | null): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolvePromise(owner)
    }
    socket.setEncoding("utf8")
    socket.setTimeout(500, () => finish(null))
    socket.once("error", () => finish(null))
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({
        id: "process-sweep-owner-attestation",
        jsonrpc: "2.0",
        method: "daemon/ping",
        params: { authToken },
      })}\n`)
    })
    socket.on("data", (chunk: string) => {
      buffer += chunk
      const lineEnd = buffer.indexOf("\n")
      if (lineEnd < 0) return
      const line = buffer.slice(0, lineEnd).trim()
      if (line.length === 0) return finish(null)
      try {
        const response: unknown = JSON.parse(line)
        if (!isRecord(response) || response.id !== "process-sweep-owner-attestation" || "error" in response) {
          return finish(null)
        }
        finish(parseLspDaemonOwner(response.result))
      } catch {
        finish(null)
      }
    })
  })
}

function sameOwner(left: LspDaemonOwnerIdentity, right: LspDaemonOwnerIdentity): boolean {
  return left.pid === right.pid
    && left.nonce === right.nonce
    && left.startedAt === right.startedAt
    && left.endpoint.kind === right.endpoint.kind
    && left.endpoint.path === right.endpoint.path
    && left.endpoint.dev === right.endpoint.dev
    && left.endpoint.ino === right.endpoint.ino
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
