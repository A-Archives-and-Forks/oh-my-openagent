import { afterEach, describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { claimRunTerminal, readRunTerminalClaim, runTerminalClaimPath } from "./run-terminal-claim"

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

async function runDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "run-terminal-claim-"))
  roots.push(root)
  return root
}

describe("run terminal claim", () => {
  test("#given a claim file left empty by a crash #when arbitration retries #then it recovers with one valid claim", async () => {
    // given
    const dir = await runDir()
    writeFileSync(runTerminalClaimPath(dir), "")

    // when
    const claim = claimRunTerminal(dir, { runId: "run-1", attempt: 1 }, "abandon", { getPidLiveness: () => "dead" })

    // then
    expect(claim.kind).toBe("abandon")
    expect(readRunTerminalClaim(dir)).toMatchObject({ kind: "abandon", runId: "run-1", attempt: 1 })
  }, 30_000)

  test("#given a live publish claim #when abandonment claims #then the publisher keeps the claim", async () => {
    // given
    const dir = await runDir()
    claimRunTerminal(dir, { runId: "run-1", attempt: 1 }, "publish", {}, 4242)

    // when
    const claim = claimRunTerminal(dir, { runId: "run-1", attempt: 1 }, "abandon", { getPidLiveness: () => "alive" })

    // then
    expect(claim.kind).toBe("publish")
    expect(claim.claimantPid).toBe(4242)
  }, 30_000)
})
