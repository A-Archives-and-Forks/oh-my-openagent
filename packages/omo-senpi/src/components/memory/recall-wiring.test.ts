import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile } from "node:fs/promises"
import { realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { BeforeAgentStartEventResult } from "@code-yeongyu/senpi"
import { GitMemoryRepo, buildIdentityPaths } from "@oh-my-opencode/memory-core"

import { MemoryFakeExtensionAPI, memorySettings } from "./memory.test-support"
import { createMemoryBinding } from "./binding"
import { createMemoryIdentityContext, type MemoryIdentityContext } from "./context"
import { MEMORY_NOTICE_CUSTOM_TYPE } from "./prompt"
import { RECALL_CUSTOM_TYPE, createMemoryRecallWiring } from "./recall-wiring"
import { rmEfaultTolerant } from "./teardown.test-support"

const IDENTITY = "recall-agent"
const SESSION_ID = "session-recall-1"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => rmEfaultTolerant(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })),
  )
})

interface Fixture {
  readonly repo: GitMemoryRepo
  readonly context: MemoryIdentityContext
}

async function fixture(): Promise<Fixture> {
  const dir = realpathSync.native(await mkdtemp(join(tmpdir(), "memory-recall-")))
  tempDirs.push(dir)
  const repo = new GitMemoryRepo({ dir: join(dir, "repo"), agentId: IDENTITY })
  await repo.init({
    seedFiles: [
      {
        relativePath: "system/persona.md",
        content: "---\ndescription: Persona\n---\nsystem text\n",
      },
      {
        relativePath: "reference/kubernetes-rollouts.md",
        content:
          "---\ndescription: How the team ships kubernetes rollouts\n---\nAlways drain kubernetes nodes before a rollout, then verify the deployment health endpoint.\n",
      },
    ],
  })
  const context = createMemoryIdentityContext({
    identity: IDENTITY,
    identityPaths: buildIdentityPaths(join(dir, "memory"), IDENTITY),
    binding: createMemoryBinding({ identity: IDENTITY, repoPath: repo.dir, boundAt: 0 }),
  })
  return { repo, context }
}

function beforeAgentStart(): unknown {
  return { type: "before_agent_start", prompt: "hello", systemPrompt: "SYSTEM" }
}

type BranchEntry = Record<string, unknown>

function userEntry(id: string, text: string): BranchEntry {
  return { type: "message", id, message: { role: "user", content: [{ type: "text", text }] } }
}

function customMessageEntry(id: string, customType: string, content: string): BranchEntry {
  return { type: "custom_message", id, customType, content, display: false }
}

function eventContext(entries: readonly BranchEntry[], sessionId = SESSION_ID): unknown {
  return {
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => entries,
    },
  }
}

interface WiringInput {
  readonly context?: MemoryIdentityContext | undefined
  readonly repo: GitMemoryRepo
  readonly identity: MemoryIdentityContext
  readonly recall?: Partial<ReturnType<typeof memorySettings>["recall"]>
  readonly env?: Record<string, string | undefined>
  readonly logs?: Array<{ message: string; details?: unknown }>
}

function wiringFor(input: WiringInput) {
  const settings = memorySettings({
    recall: { ...memorySettings().recall, ...input.recall },
  })
  return createMemoryRecallWiring({
    resolveContext: (sessionId) =>
      sessionId === SESSION_ID && input.context !== null ? (input.context ?? input.identity) : undefined,
    resolveSettings: () => settings,
    createRepo: () => input.repo,
    env: input.env ?? {},
    ...(input.logs === undefined
      ? {}
      : {
          logger: {
            info: (message, details) => input.logs?.push({ message, details }),
            warn: (message, details) => input.logs?.push({ message, details }),
            error: (message, details) => input.logs?.push({ message, details }),
          },
        }),
  })
}

async function dispatch(
  pi: MemoryFakeExtensionAPI,
  ctx: unknown,
): Promise<BeforeAgentStartEventResult | undefined> {
  const results = await pi.dispatch("before_agent_start", beforeAgentStart(), ctx)
  return results.find((result) => result !== undefined) as BeforeAgentStartEventResult | undefined
}

describe("RECALL_CUSTOM_TYPE", () => {
  test("#given the recall injection channel #when the custom type is read #then it is the memorian recall channel", () => {
    // given / when / then
    expect(RECALL_CUSTOM_TYPE).toBe("omo-memorian:recall")
  })
})

describe("createMemoryRecallWiring", () => {
  test("#given a bound session matching the corpus #when before_agent_start dispatches #then a hidden recall message is returned", async () => {
    // given
    const { repo, context } = await fixture()
    const pi = new MemoryFakeExtensionAPI()
    wiringFor({ repo, identity: context }).register(pi)

    // when
    const result = await dispatch(pi, eventContext([userEntry("m1", "how do we handle kubernetes rollouts here")]))

    // then
    expect(result?.message?.customType).toBe(RECALL_CUSTOM_TYPE)
    expect(result?.message?.display).toBe(false)
    expect(String(result?.message?.content)).toContain("reference/kubernetes-rollouts.md")
    expect(result?.systemPrompt).toBeUndefined()
  }, 30_000)

  test("#given a recall hit #when the handler finishes #then a rendered transcript entry names the surfaced path", async () => {
    // given
    const { repo, context } = await fixture()
    const pi = new MemoryFakeExtensionAPI()
    wiringFor({ repo, identity: context }).register(pi)

    // when
    await dispatch(pi, eventContext([userEntry("m1", "how do we handle kubernetes rollouts here")]))

    // then
    expect(pi.entryRenderers.map((registration) => registration.customType)).toContain(RECALL_CUSTOM_TYPE)
    expect(pi.entries).toEqual([
      { customType: RECALL_CUSTOM_TYPE, data: { paths: ["reference/kubernetes-rollouts.md"] } },
    ])
  }, 30_000)

  test("#given no recall hit #when before_agent_start dispatches #then no transcript entry is appended", async () => {
    // given
    const { repo, context } = await fixture()
    const pi = new MemoryFakeExtensionAPI()
    wiringFor({ repo, identity: context }).register(pi)

    // when
    await dispatch(pi, eventContext([userEntry("m1", "zzzqqq unrelated chatter")]))

    // then
    expect(pi.entries).toEqual([])
  }, 30_000)

  test("#given recall disabled by config #when before_agent_start dispatches #then no message is returned", async () => {
    // given
    const { repo, context } = await fixture()
    const pi = new MemoryFakeExtensionAPI()
    wiringFor({ repo, identity: context, recall: { enabled: false } }).register(pi)

    // when
    const result = await dispatch(pi, eventContext([userEntry("m1", "kubernetes rollouts")]))

    // then
    expect(result).toBeUndefined()
  }, 30_000)

  test("#given a memory worker child sentinel #when before_agent_start dispatches #then no message is returned", async () => {
    // given
    const { repo, context } = await fixture()
    const reflection = new MemoryFakeExtensionAPI()
    const facts = new MemoryFakeExtensionAPI()
    wiringFor({ repo, identity: context, env: { SENPI_MEMORY_REFLECTION: "1" } }).register(reflection)
    wiringFor({ repo, identity: context, env: { SENPI_MEMORY_FACTS: "1" } }).register(facts)

    // when
    const reflectionResult = await dispatch(reflection, eventContext([userEntry("m1", "kubernetes rollouts")]))
    const factsResult = await dispatch(facts, eventContext([userEntry("m1", "kubernetes rollouts")]))

    // then
    expect(reflectionResult).toBeUndefined()
    expect(factsResult).toBeUndefined()
  }, 30_000)

  test("#given an unbound session #when before_agent_start dispatches #then no message is returned", async () => {
    // given
    const { repo, context } = await fixture()
    const pi = new MemoryFakeExtensionAPI()
    wiringFor({ repo, identity: context }).register(pi)

    // when
    const result = await dispatch(
      pi,
      eventContext([userEntry("m1", "kubernetes rollouts")], "unbound-session"),
    )

    // then
    expect(result).toBeUndefined()
  }, 30_000)

  test("#given conversation text matching nothing in the corpus #when before_agent_start dispatches #then no message is returned", async () => {
    // given
    const { repo, context } = await fixture()
    const pi = new MemoryFakeExtensionAPI()
    wiringFor({ repo, identity: context }).register(pi)

    // when
    const result = await dispatch(pi, eventContext([userEntry("m1", "zzzqqq unrelated chatter")]))

    // then
    expect(result).toBeUndefined()
  }, 30_000)

  test("#given a path already surfaced in the session #when before_agent_start dispatches again #then the hint never repeats", async () => {
    // given
    const { repo, context } = await fixture()
    const pi = new MemoryFakeExtensionAPI()
    wiringFor({ repo, identity: context }).register(pi)
    const ctx = eventContext([userEntry("m1", "how do we handle kubernetes rollouts here")])
    const first = await dispatch(pi, ctx)

    // when
    const second = await dispatch(pi, ctx)

    // then
    expect(first?.message?.customType).toBe(RECALL_CUSTOM_TYPE)
    expect(second).toBeUndefined()
  }, 30_000)

  test("#given an injected recall hint in the branch #when the query window is built #then recall and notice entries are excluded", async () => {
    // given
    const { repo, context } = await fixture()
    const pi = new MemoryFakeExtensionAPI()
    wiringFor({ repo, identity: context }).register(pi)

    // when: the only kubernetes text in the branch lives inside memory-owned hidden entries
    const result = await dispatch(
      pi,
      eventContext([
        customMessageEntry("c1", RECALL_CUSTOM_TYPE, "<recalled-memory>kubernetes rollouts</recalled-memory>"),
        customMessageEntry("c2", MEMORY_NOTICE_CUSTOM_TYPE, "<memory_notice>kubernetes rollouts</memory_notice>"),
        userEntry("m1", "zzzqqq unrelated chatter"),
      ]),
    )

    // then
    expect(result).toBeUndefined()
  }, 30_000)

  test("#given a successful injection #when the handler finishes #then the ledger and the receipt record the surfaced path", async () => {
    // given
    const { repo, context } = await fixture()
    const pi = new MemoryFakeExtensionAPI()
    wiringFor({ repo, identity: context }).register(pi)

    // when
    await dispatch(pi, eventContext([userEntry("m1", "how do we handle kubernetes rollouts here")]))

    // then
    const receipts = await readFile(context.identityPaths.recallReceipts, "utf8")
    const receipt = JSON.parse(receipts.trim().split("\n")[0] ?? "{}")
    expect(receipt.sessionId).toBe(SESSION_ID)
    expect(receipt.injected).toEqual([
      expect.objectContaining({ path: "reference/kubernetes-rollouts.md" }),
    ])
  }, 30_000)

  test("#given a tiny token budget #when the block is rendered #then the content is truncated to the four-chars-per-token budget", async () => {
    // given
    const { repo, context } = await fixture()
    const pi = new MemoryFakeExtensionAPI()
    wiringFor({ repo, identity: context, recall: { ...memorySettings().recall, budget_tokens: 10 } }).register(pi)

    // when
    const result = await dispatch(pi, eventContext([userEntry("m1", "how do we handle kubernetes rollouts here")]))

    // then
    expect(String(result?.message?.content).length).toBeLessThanOrEqual(40)
  }, 30_000)

  test("#given a corpus load failure #when before_agent_start dispatches #then the turn is unaffected and the failure is logged", async () => {
    // given
    const { repo, context } = await fixture()
    const logs: Array<{ message: string; details?: unknown }> = []
    class BrokenRepo extends GitMemoryRepo {
      override async head(): Promise<string | null> {
        throw new Error("git head unavailable")
      }
    }
    const broken = new BrokenRepo({ dir: repo.dir, agentId: IDENTITY })
    const pi = new MemoryFakeExtensionAPI()
    wiringFor({ repo: broken, identity: context, logs }).register(pi)

    // when
    const result = await dispatch(pi, eventContext([userEntry("m1", "how do we handle kubernetes rollouts here")]))

    // then
    expect(result).toBeUndefined()
    expect(logs.length).toBeGreaterThan(0)
  }, 30_000)
})
