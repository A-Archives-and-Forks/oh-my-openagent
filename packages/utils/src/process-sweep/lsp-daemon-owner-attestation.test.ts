import { describe, expect, test } from "bun:test"

import { attestLspDaemonCliProcess } from "./lsp-daemon-family"
import { attestLspDaemonOwner, type LspDaemonOwnerIdentity } from "./lsp-daemon-owner-attestation"

describe("owner-bound lsp-daemon attestation", () => {
  test("#given unrelated generic daemon argv #when owner ping cannot prove identity #then the process is spared", async () => {
    const owner: LspDaemonOwnerIdentity = {
      endpoint: { dev: 1, ino: 2, kind: "unix", path: "/tmp/daemon.sock" },
      nonce: "owner-nonce",
      pid: 4242,
      startedAt: "2026-07-30T00:00:00.000Z",
    }
    const target = { authPath: "/tmp/auth.token", owner, ownerPath: "/tmp/daemon.owner", pid: owner.pid }
    const genericArgvAttested = await attestLspDaemonCliProcess(owner.pid, "linux", {
      readProcFile: async () => Buffer.from("/usr/bin/node\0/tmp/cli.js\0daemon\0"),
    })
    const ownerAttested = await attestLspDaemonOwner(target, {
      pingOwner: async () => null,
      readText: async (path) => path === target.ownerPath ? JSON.stringify(owner) : "auth-token",
    })

    expect(genericArgvAttested).toBe(true)
    expect(ownerAttested).toBe(false)
  })

  test("#given the unchanged owner and authenticated ping #when attested #then identity is proven", async () => {
    const owner: LspDaemonOwnerIdentity = {
      endpoint: { dev: 1, ino: 2, kind: "unix", path: "/tmp/daemon.sock" },
      nonce: "owner-nonce",
      pid: 4242,
      startedAt: "2026-07-30T00:00:00.000Z",
    }
    const target = { authPath: "/tmp/auth.token", owner, ownerPath: "/tmp/daemon.owner", pid: owner.pid }

    expect(await attestLspDaemonOwner(target, {
      pingOwner: async () => owner,
      readText: async (path) => path === target.ownerPath ? JSON.stringify(owner) : "auth-token",
    })).toBe(true)
  })
})
