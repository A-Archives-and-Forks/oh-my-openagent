import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { writeFileSync } from "node:fs"
import type { Socket } from "node:net"
import { win32 } from "node:path"

/**
 * The engine's socket transport contract, mirrored for the fake host.
 *
 * On POSIX a client connects to the logical socket path. On win32 there is no unix socket: the
 * client reads a 32-byte secret from `<logical path>.secret`, connects to a named pipe whose name
 * is derived from the normalized logical path plus that secret, and sends the secret as the first
 * bytes of the connection. The engine refuses a raw pipe address, so the fake host keeps the
 * logical path as its public address and does the derivation here, exactly as the real host does.
 */
const WINDOWS_PIPE_PREFIX = "\\\\.\\pipe\\senpi-rpc-"
const SECRET_BYTES = 32
const HANDSHAKE_TIMEOUT_MS = 2_000

export interface FakeHostTransport {
  /** What `net.Server.listen` binds: the logical path on POSIX, the derived pipe on win32. */
  readonly listenAddress: string
  /** Runs `accept` once the connection is allowed to carry wire frames. */
  authenticate(socket: Socket, accept: () => void): void
}

export function fakeHostTransport(socketPath: string, platform: NodeJS.Platform = process.platform): FakeHostTransport {
  if (platform !== "win32") return { listenAddress: socketPath, authenticate: (_socket, accept) => accept() }
  const secret = randomBytes(SECRET_BYTES)
  writeFileSync(`${socketPath}.secret`, secret, { mode: 0o600 })
  const canonical = win32.normalize(socketPath).toLowerCase()
  const name = createHash("sha256")
    .update(Buffer.concat([Buffer.from(canonical, "utf8"), secret]))
    .digest("hex")
    .slice(0, 32)
  return {
    listenAddress: `${WINDOWS_PIPE_PREFIX}${name}`,
    authenticate: (socket, accept) => authenticateHandshake(socket, secret, accept),
  }
}

function authenticateHandshake(socket: Socket, secret: Buffer, accept: () => void): void {
  let received = Buffer.alloc(0)
  const finish = (): void => {
    clearTimeout(timer)
    socket.off("data", onData)
    socket.off("error", onError)
  }
  const onError = (): void => {
    finish()
    socket.destroy()
  }
  const timer = setTimeout(() => {
    finish()
    socket.destroy()
  }, HANDSHAKE_TIMEOUT_MS)
  const onData = (chunk: Buffer): void => {
    received = Buffer.concat([received, chunk])
    if (received.length < secret.length) return
    finish()
    if (!timingSafeEqual(received.subarray(0, secret.length), secret)) {
      socket.destroy()
      return
    }
    const remainder = received.subarray(secret.length)
    if (remainder.length > 0) socket.unshift(remainder)
    accept()
  }
  socket.on("data", onData)
  socket.once("error", onError)
  socket.once("close", finish)
}
