import { describe, expect, test } from "bun:test"
import { connect } from "node:net"

import { startFakeHost, type FakeHost } from "./__fixtures__/fake-host"
import { probeFakeHost } from "./__fixtures__/fake-host-probe"
import { fakeHostTransport } from "./__fixtures__/fake-host-transport"

// The restarted generation must be the ONLY one answering the logical socket path. A restart
// under a reconnect storm is the scenario the integration suites pin: N clients hold live
// connections when the host dies; they reconnect around the restart. If a second address is
// ever published (or the old listener still accepts), children are resumed twice.
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

  test("#given clients connected across a restart #when they reconnect #then each connection is answered by exactly one generation", async () => {
    const host = await startFakeHost()
    const transport = fakeHostTransport(host.socketPath)
    const clients = 8
    try {
      // N live connections, each holding the current address open.
      const held: Array<ReturnType<typeof connect>> = []
      for (let index = 0; index < clients; index += 1) {
        const socket = connect(transport.listenAddress)
        held.push(socket)
      }
      await host.waitForConnections(clients)

      await host.restart()

      // Every reconnection lands on the one live generation: the single published
      // address answers, and the answer count never exceeds the client count.
      let answered = 0
      await Promise.all(
        Array.from({ length: clients }, async () => {
          const socket = connect(transport.listenAddress)
          await new Promise<void>((resolve, reject) => {
            socket.once("connect", () => resolve())
            socket.once("error", reject)
          })
          socket.destroy()
          answered += 1
        }),
      )
      expect(answered).toBe(clients)
      expect(host.connections).toBeLessThanOrEqual(clients)
    } finally {
      await host.stop()
    }
  })
})
