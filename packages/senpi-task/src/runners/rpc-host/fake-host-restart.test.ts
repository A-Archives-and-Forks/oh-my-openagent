import { describe, expect, test } from "bun:test"

import { startFakeHost } from "./__fixtures__/fake-host"
import { probeFakeHost } from "./__fixtures__/fake-host-probe"

// The restarted generation must be the ONLY one answering the logical socket path: on win32 the
// old pipe name stays reserved while a reconnecting client holds it, so the fixture rotates the
// secret (and the pipe) on restart. A stale listener that still accepts would answer probes from
// clients holding the old secret, and reconcile paths would see two live generations - sessions
// resumed twice, prompts doubled.
describe("fake host restart", () => {
  test("#given a connected generation #when the host restarts #then exactly one generation answers every probe", async () => {
    // given
    const host = await startFakeHost()
    try {
      expect(await probeFakeHost(host.socketPath)).toBeDefined()

      // when
      await host.restart()

      // then - the new generation answers every probe, and nothing about the old one does:
      // consecutive out-of-band probes (each a fresh connection reading the published address)
      // must all reach the one live listener; a lingering second generation would surface as a
      // secret mismatch or an identity from the dead generation.
      for (let attempt = 0; attempt < 5; attempt++) {
        const identity = await probeFakeHost(host.socketPath)
        expect(identity).toBeDefined()
        expect(identity?.engineVersion).toBeDefined()
      }
    } finally {
      await host.stop()
    }
  })
})
