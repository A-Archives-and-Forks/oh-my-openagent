import { createServer, type AddressInfo, type Server, type Socket } from "node:net"

const CLEANUP_WAIT_MS = 5_000

export function createMemoryRunSupervisorIc8ExitResources(waitMs: number) {
  const exitServers = new Set<Server>()
  const exitServerClosures = new Map<Server, Promise<void>>()
  const acceptedSockets = new Set<Socket>()
  const socketClosures = new Map<Socket, Promise<void>>()
  const childExitTimeouts = new Set<ReturnType<typeof setTimeout>>()

  const clearTrackedTimeout = (timeout: ReturnType<typeof setTimeout>) => {
    clearTimeout(timeout)
    childExitTimeouts.delete(timeout)
  }

  const waitBounded = <T>(
    signal: Promise<T>,
    timeoutMs: number,
    description: string,
  ): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        childExitTimeouts.delete(timeout)
        reject(new Error(`waited ${timeoutMs}ms for ${description}`))
      }, timeoutMs)
      childExitTimeouts.add(timeout)
      signal.then(
        (value) => {
          clearTrackedTimeout(timeout)
          resolve(value)
        },
        (error: unknown) => {
          clearTrackedTimeout(timeout)
          reject(error)
        },
      )
    })

  const closeExitServer = async (server: Server): Promise<void> => {
    const existing = exitServerClosures.get(server)
    if (existing !== undefined) return existing
    if (!server.listening) {
      server.removeAllListeners()
      exitServers.delete(server)
      return
    }
    const closing = new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
    exitServerClosures.set(server, closing)
    try {
      await closing
    } finally {
      server.removeAllListeners()
      exitServerClosures.delete(server)
      exitServers.delete(server)
    }
  }

  const openServer = async () => {
    const server = createServer()
    exitServers.add(server)
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error)
      server.once("error", onError)
      server.listen(0, "127.0.0.1", () => {
        server.off("error", onError)
        resolve()
      })
    })
    const address = server.address() as AddressInfo
    server.on("connection", (socket) => {
      acceptedSockets.add(socket)
      socketClosures.set(
        socket,
        new Promise<void>((resolve) => socket.once("close", resolve)),
      )
    })
    const exitSocketAccepted = new Promise<Socket>((resolve) =>
      server.once("connection", resolve),
    )
    const childExited = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        childExitTimeouts.delete(timeout)
        reject(new Error(`waited ${waitMs}ms for model child exit`))
      }, waitMs)
      childExitTimeouts.add(timeout)
      void exitSocketAccepted
        .then(async (socket) => {
          const closed = socketClosures.get(socket)
          if (closed === undefined) throw new Error("accepted model socket is not tracked")
          const serverClosed = closeExitServer(server)
          await closed
          await serverClosed
          clearTrackedTimeout(timeout)
          resolve()
        })
        .catch((error: unknown) => {
          clearTrackedTimeout(timeout)
          reject(error)
        })
    })
    return { port: address.port, childExited, exitSocketAccepted }
  }

  const cleanup = async (): Promise<void> => {
    let cleanupError: Error | undefined
    try {
      try {
        if (socketClosures.size > 0) {
          await waitBounded(
            Promise.all([...socketClosures.values()]).then(() => undefined),
            CLEANUP_WAIT_MS,
            "model socket close",
          )
        }
      } catch {
        for (const socket of acceptedSockets) socket.destroy()
        try {
          await waitBounded(
            Promise.all([...socketClosures.values()]).then(() => undefined),
            CLEANUP_WAIT_MS,
            "forced model socket close",
          )
        } catch (error) {
          cleanupError = error instanceof Error ? error : new Error(String(error))
        }
      }
      try {
        await waitBounded(
          Promise.all([...exitServers].map(closeExitServer)).then(() => undefined),
          CLEANUP_WAIT_MS,
          "exit server close",
        )
      } catch (error) {
        cleanupError ??= error instanceof Error ? error : new Error(String(error))
      }
    } finally {
      for (const socket of acceptedSockets) {
        socket.removeAllListeners()
        socket.destroy()
      }
      for (const server of exitServers) server.removeAllListeners()
      acceptedSockets.clear()
      socketClosures.clear()
      exitServers.clear()
      exitServerClosures.clear()
      for (const timeout of childExitTimeouts) clearTimeout(timeout)
      childExitTimeouts.clear()
    }
    if (cleanupError !== undefined) throw cleanupError
  }

  return {
    cleanup,
    clearTrackedTimeout,
    counts: () => ({
      exitServers: exitServers.size,
      acceptedSockets: acceptedSockets.size,
      childExitTimeouts: childExitTimeouts.size,
    }),
    openServer,
    trackTimeout: (timeout: ReturnType<typeof setTimeout>) =>
      childExitTimeouts.add(timeout),
    waitBounded,
  }
}
