import { afterEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { GitMemoryRepo, resolveMemoryIdentity } from "@oh-my-opencode/memory-core"

import { createMemoryComponent } from "./index"
import {
  MemoryFakeExtensionAPI,
  componentContext,
  loadedMemoryConfig,
  memorySettings,
} from "./memory.test-support"

const COMMIT_TIME = "2026-08-10T00:00:00.000Z"
const NOW = Date.parse("2026-08-10T00:01:30.000Z")
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("memory footer wiring", () => {
  test("#given committed memory bound without a visible footer #when memory tools return #then only the first result shows relative age", async () => {
    const fixture = await createFixture()
    const pi = new MemoryFakeExtensionAPI()
    const statusCalls: Array<{ key: string; text: string | undefined }> = []
    createMemoryComponent({
      env: fixture.env,
      loadConfig: () => loadedMemoryConfig(memorySettings()),
      now: () => NOW,
      resolveCwd: () => fixture.cwd,
    }).register(pi, componentContext())

    await pi.dispatch("session_start", { type: "session_start" }, sessionContext(fixture.sessionId))
    expect(statusCalls).toEqual([])

    const toolContext = sessionContext(fixture.sessionId, statusCalls)
    await pi.dispatch("tool_result", memoryResult("mcp_omo-memory_memory"), toolContext)
    await pi.dispatch("tool_result", memoryResult("mcp_omo-memory_memory_apply_patch"), toolContext)
    await pi.dispatch("tool_result", memoryResult("read"), toolContext)

    expect(statusCalls).toEqual([
      { key: "memory", text: `mem:${fixture.identity} 1m ago` },
    ])
    await pi.dispatch("session_shutdown", { type: "session_shutdown" }, toolContext)
  })

  test("#given a completed first-use attempt #when a new session starts #then the once-only footer gate resets", async () => {
    const fixture = await createFixture()
    const pi = new MemoryFakeExtensionAPI()
    const statusCalls: Array<{ key: string; text: string | undefined }> = []
    createMemoryComponent({
      env: fixture.env,
      loadConfig: () => loadedMemoryConfig(memorySettings()),
      now: () => NOW,
      resolveCwd: () => fixture.cwd,
    }).register(pi, componentContext())

    const first = sessionContext("session-first", statusCalls)
    await pi.dispatch("session_start", { type: "session_start" }, sessionContext("session-first"))
    await pi.dispatch("tool_result", memoryResult("memory"), first)
    await pi.dispatch("session_shutdown", { type: "session_shutdown" }, first)

    const second = sessionContext("session-second", statusCalls)
    await pi.dispatch("session_start", { type: "session_start" }, sessionContext("session-second"))
    await pi.dispatch("tool_result", memoryResult("memory"), second)

    expect(statusCalls).toEqual([
      { key: "memory", text: `mem:${fixture.identity} 1m ago` },
      { key: "memory", text: `mem:${fixture.identity} 1m ago` },
    ])
    await pi.dispatch("session_shutdown", { type: "session_shutdown" }, second)
  })
})

async function createFixture(): Promise<{
  readonly cwd: string
  readonly env: { readonly OMO_MEMORY_HOME: string }
  readonly identity: string
  readonly sessionId: string
}> {
  const root = await mkdtemp(join(tmpdir(), "omo-memory-footer-wiring-"))
  roots.push(root)
  const cwd = join(root, "project")
  const env = { OMO_MEMORY_HOME: join(root, "memory") }
  const identity = resolveMemoryIdentity("auto", cwd, env)
  const repo = new GitMemoryRepo({ dir: identity.paths.repo, agentId: identity.id })
  await repo.init({
    authorName: "Memory Footer Test",
    seedFiles: [{ relativePath: "system/persona.md", content: "test persona\n" }],
  })
  execFileSync("git", ["commit", "--amend", "--no-edit", `--date=${COMMIT_TIME}`], {
    cwd: identity.paths.repo,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: COMMIT_TIME,
      GIT_COMMITTER_DATE: COMMIT_TIME,
    },
  })
  return { cwd, env, identity: identity.id, sessionId: "session-memory-footer" }
}

function memoryResult(toolName: string): Record<string, unknown> {
  return {
    type: "tool_result",
    toolName,
    isError: false,
    input: {},
    content: [{ type: "text", text: "done" }],
  }
}

function sessionContext(
  sessionId: string,
  statusCalls?: Array<{ key: string; text: string | undefined }>,
): unknown {
  return {
    sessionManager: {
      getEntries: () => [],
      getSessionId: () => sessionId,
    },
    ui: {
      notify: () => {},
      ...(statusCalls === undefined
        ? {}
        : {
            setStatus: (key: string, text: string | undefined) => {
              statusCalls.push({ key, text })
            },
          }),
    },
  }
}
