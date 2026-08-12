import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { buildIdentityPaths } from "@oh-my-opencode/memory-core"

import { collectReflection } from "../palace/collectors"
import {
  REFLECTION_COMPLETION_ENTRY_TYPE,
  consumePendingReflectionCompletions,
  ensureReflectionCompletion,
  recordReflectionCompletion,
  registerReflectionCompletionRenderer,
  type ReflectionCompletionRecord,
} from "./completion"
import { CapturedCompletionApi } from "./runner.test-support"
import { realpathSync } from "node:fs"

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }))))

function record(): ReflectionCompletionRecord {
  return {
    schemaVersion: 1,
    runId: "run-offline",
    identity: "agent-test",
    category: "quick",
    model: "omo-mock/mock-1",
    thinking: "high",
    conversationIds: ["conversation-a"],
    trigger: "dream",
    origin: "shutdown",
    outcome: "merged",
    startedAt: "2026-08-09T12:00:00.000Z",
    finishedAt: "2026-08-09T12:00:01.000Z",
    delivery: { status: "pending" },
  }
}

describe("reflection completion flow", () => {
  test("#given an existing consumed completion #when a retry ensures the same pending record #then consumed delivery is preserved", async () => {
    // given
    const root = realpathSync.native(await mkdtemp(join(tmpdir(), "reflection-completion-")))
    roots.push(root)
    const api = new CapturedCompletionApi()
    await recordReflectionCompletion(root, record(), {
      sessionId: "conversation-a",
      api,
    })

    // when
    const ensured = await ensureReflectionCompletion(root, record())

    // then
    expect(ensured.delivery.status).toBe("consumed")
    expect(JSON.parse(await readFile(join(root, "run-offline.json"), "utf8"))).toEqual(ensured)
  })

  test("#given an existing completion with a different outcome #when ensured #then corruption is rejected without overwrite", async () => {
    // given
    const root = realpathSync.native(await mkdtemp(join(tmpdir(), "reflection-completion-")))
    roots.push(root)
    await recordReflectionCompletion(root, record())
    const mismatched: ReflectionCompletionRecord = { ...record(), outcome: "failed" }

    // when
    const ensure = ensureReflectionCompletion(root, mismatched)

    // then
    await expect(ensure).rejects.toThrow("completion record mismatch")
    expect(JSON.parse(await readFile(join(root, "run-offline.json"), "utf8"))).toMatchObject({
      outcome: "merged",
    })
  })

  test("#given no live source session #when completion is recorded #then it remains durable and pending", async () => {
    // given
    const root = realpathSync.native(await mkdtemp(join(tmpdir(), "reflection-completion-")))
    roots.push(root)

    // when
    const written = await recordReflectionCompletion(root, record())

    // then
    expect(written.delivery.status).toBe("pending")
    const persisted: unknown = JSON.parse(await readFile(join(root, "run-offline.json"), "utf8"))
    expect(persisted).toEqual(written)
    expect(persisted).toMatchObject({
      runId: "run-offline",
      trigger: "dream",
      origin: "shutdown",
      outcome: "merged",
      finishedAt: "2026-08-09T12:00:01.000Z",
    })
  })

  test("#given a worker completion record #when the landed palace collector reads reflection outcomes #then runId outcome and finishedAt match its contract", async () => {
    // given
    const root = realpathSync.native(await mkdtemp(join(tmpdir(), "reflection-completion-")))
    roots.push(root)
    const paths = buildIdentityPaths(root, "agent-test")
    await recordReflectionCompletion(join(paths.reflection, "completions"), record())

    // when
    const reflection = await collectReflection(paths, { limit: 5 })

    // then
    expect(reflection.outcomes).toEqual([{
      runId: "run-offline",
      outcome: "merged",
      finishedAt: "2026-08-09T12:00:01.000Z",
    }])
  })

  test("#given a pending offline completion #when its source session starts #then appendEntry notify and consumed state happen without a model message", async () => {
    // given
    const root = realpathSync.native(await mkdtemp(join(tmpdir(), "reflection-completion-")))
    roots.push(root)
    await recordReflectionCompletion(root, record())
    const api = new CapturedCompletionApi()
    const notifications: Array<{ message: string; level: string }> = []
    registerReflectionCompletionRenderer(api)

    // when
    const consumed = await consumePendingReflectionCompletions(root, {
      sessionId: "conversation-a",
      api,
      ui: { notify: (message, level) => notifications.push({ message, level }) },
    })

    // then
    expect(consumed).toHaveLength(1)
    expect(api.renderers.map((item) => item.customType)).toEqual([REFLECTION_COMPLETION_ENTRY_TYPE])
    expect(api.entries).toEqual([{ customType: REFLECTION_COMPLETION_ENTRY_TYPE, data: consumed[0] }])
    expect(notifications).toHaveLength(1)
    expect(consumed[0]?.delivery).toMatchObject({ status: "consumed", sessionId: "conversation-a" })
  })
})
