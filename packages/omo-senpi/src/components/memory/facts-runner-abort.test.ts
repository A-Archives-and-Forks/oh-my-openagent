import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"

import { FactsExtractorRunner } from "./facts-runner"
import { fixture, runnerOptions } from "./facts-runner.test-support"

describe("facts runner shutdown abort boundary", () => {
  test("#given an aborted drain signal #when launch is attempted #then no run is reserved, no child spawns, and the batch stays retryable", async () => {
    // given
    const { root, identity, queue } = await fixture()
    const runner = new FactsExtractorRunner(runnerOptions(root, identity, queue, "fact", {}))
    const aborted = new AbortController()
    aborted.abort()

    // when
    const result = await runner.launchPending(aborted.signal)

    // then
    expect(result.status).toBe("skipped")
    expect(await queue.listPending()).toHaveLength(1)
    expect(existsSync(join(identity.paths.facts, "runs"))).toBe(false)
  })
})
