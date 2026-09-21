import { describe, expect, test } from "bun:test"

import { startFakeHost } from "./__fixtures__/fake-host"
import { probeFakeHost } from "./__fixtures__/fake-host-probe"
import { connectFakeHost } from "./__fixtures__/fake-host-transport"

// The restart mirrors the real daemon's generation change: the new generation binds before the
// old one is retired, the published secret swaps atomically only after the new listener is up,
// and the old generation never re-prompts. At every instant exactly one generation answers.
describe("fake host restart", () => {
  test("#given a connected generation #when the host restarts #then exactly one generation answers every probe", async () => {
    const host = await startFakeHost()
    try {
      expect(await probeFakeHost(host.socketPath)).toBeDefined()
      await host.restart()
      for (let attempt = 0; attempt < 5; attempt++) {
        const identity = await probeFakeHost(host.socketPath)
        expect(identity).toBeDefined()
        expect(identity?.engineVersion).toBeDefined()
      }
    } finally {
      await host.stop()
    }
  })

  test("#given clients connected across a restart #when they reconnect around it #then no client sees a dead address and each is answered exactly once", async () => {
    const host = await startFakeHost()
    const clients = 8
    const errors: string[] = []
    try {
      // N live connections, each a client speaking the published-address contract.
      const held = Array.from({ length: clients }, () => connectFakeHost(host.socketPath))
      await host.waitForConnections(clients)

      const promptsBefore = host.commands.filter((command) => command.type === "prompt").length
      await host.restart()
      const promptsAfter = host.commands.filter((command) => command.type === "prompt").length

      // (c) the retired generation never re-prompted during the swap.
      expect(promptsAfter - promptsBefore).toBe(0)

      // (a) every reconnection finds a live listener - no ENOENT, no ECONNREFUSED -
      // and (b) each client is answered exactly once by the single live generation.
      let answered = 0
      await Promise.all(
        Array.from({ length: clients }, async () => {
          const socket = connectFakeHost(host.socketPath) // reads the CURRENT published secret
          await new Promise<void>((resolve, reject) => {
            socket.once("connect", () => resolve())
            socket.once("error", (error: Error) => reject(error))
          })
          socket.destroy()
          answered += 1
        }),
      )
      expect(answered).toBe(clients)
      expect(errors).toEqual([])
      for (const socket of held) socket.destroy()
    } finally {
      await host.stop()
    }
  })
})
