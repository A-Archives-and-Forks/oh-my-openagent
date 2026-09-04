import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, realpathSync } from "node:fs"
import { mkdtemp, readdir, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { CreateAgentSessionOptions } from "@code-yeongyu/senpi"
import {
  PendingNudges,
  buildIdentityPaths,
  type MemoryIdentityPaths,
  type RecallCandidate,
} from "@oh-my-opencode/memory-core"
import type { ChildModelRegistry, ChildSession, ChildSessionListener, CreateChildSession } from "@oh-my-opencode/senpi-task"

import { ModelRegistry, ModelRuntime } from "../../senpi-test-runtime"
import { MemorianGateRunner } from "./memorian-runner"
import { rmEfaultTolerant } from "./teardown.test-support"

const IDENTITY = "memorian-agent"
const SESSION_ID = "session-gate-1"
const CANDIDATE_PATH = "reference/kubernetes-rollouts.md"
const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rmEfaultTolerant(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })),
  )
})

const CANDIDATES: readonly RecallCandidate[] = [
  { path: CANDIDATE_PATH, description: "Rollout policy", excerpt: "drain first", score: 1 },
]

/** The judge's 2-arg execute contract; the fake session drives it the way the senpi engine would. */
type NudgeExecute = (toolCallId: string, params: { readonly path: string; readonly hint: string }) => Promise<{
  readonly content: readonly { readonly type: string; readonly text: string }[]
  readonly isError?: boolean
}>

async function callNudge(options: CreateAgentSessionOptions, path: string, hint: string): Promise<{ readonly text: string; readonly isError: boolean }> {
  const tool = options.customTools?.find((candidate) => candidate.name === "nudge")
  if (tool === undefined) throw new Error("nudge tool missing from the child session options")
  // The child surface carries the nudge closure as a full ToolDefinition (5-arg execute); the fake
  // session drives the judge's own 2-arg contract, exactly the subset the closure implements.
  const execute = tool.execute as unknown as NudgeExecute
  const result = await execute("call-1", { path, hint })
  const text = result.content.find((part) => part.type === "text")?.text ?? ""
  return { text, isError: result.isError === true }
}

/**
 * The settle-time registry snapshot, as production captures it: the parent session's concrete
 * ModelRegistry. The runtime is created catalog-free (modelsPath: null) so the fixture owns exactly
 * which models exist - the shipped catalog would otherwise satisfy the quick chain on its own. An
 * in-process child shares this exact instance, so the judge cannot drift onto another engine's
 * model set.
 */
function registrySnapshot(models: readonly { readonly id: string }[] = [{ id: "mock-1" }]): ChildModelRegistry {
  const registry = new ModelRegistry(ModelRuntime.createSync({ modelsPath: null }))
  registry.registerProvider("omo-mock", {
    api: "openai-completions",
    baseUrl: "https://example.test",
    apiKey: "test-key",
    models: models.map((model) => ({
      id: model.id,
      name: `Mock ${model.id}`,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1,
      maxTokens: 1,
    })),
  })
  return registry
}

interface ScriptedSession {
  readonly createSession: CreateChildSession
  readonly promptTexts: string[]
  readonly created: number
  /** Resolves once the child turn has actually started (prompt() was entered). */
  whenPrompted(): Promise<void>
  /** Settle the open turn; safe to call before the turn starts (the request is deferred). */
  resolve(): void
}

/**
 * A fake in-process child session: prompt() runs the script against the session options the
 * runner assembled (custom tools, model, loader), so the script can drive real `nudge` tool calls.
 * The turn settles when the test resolves it; a never-resolved script pins the turn open.
 */
function scriptedSession(script: (options: CreateAgentSessionOptions) => Promise<void>): ScriptedSession {
  let captured: CreateAgentSessionOptions | undefined
  let settle: (() => void) | undefined
  let resolveRequested = false
  let onPrompted: (() => void) | undefined
  const prompted = new Promise<void>((resolve) => {
    onPrompted = resolve
  })
  const promptTexts: string[] = []
  let assistantText: string | undefined
  const listeners = new Set<ChildSessionListener>()
  let created = 0
  const session: ChildSession = {
    sessionId: "memorian-child-1",
    async prompt(text) {
      promptTexts.push(text)
      onPrompted?.()
      await script(captured as CreateAgentSessionOptions)
      // The turn's assistant text lands only after the script ran, mirroring a judge that answers
      // after its tool calls: the baseline the handle captured at beginTurn stays undefined.
      assistantText = "Judged."
      await new Promise<void>((resolve) => {
        settle = resolve
        if (resolveRequested) resolve()
      })
    },
    async steer() {},
    async followUp() {},
    async abort() {},
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getLastAssistantText: () => assistantText,
    dispose() {},
  }
  return {
    promptTexts,
    whenPrompted: () => prompted,
    get created() {
      return created
    },
    resolve: () => {
      resolveRequested = true
      settle?.()
    },
    createSession: async (options) => {
      created += 1
      captured = options
      return session
    },
  }
}

async function fixture(): Promise<{ root: string, identityPaths: MemoryIdentityPaths }> {
  const root = realpathSync.native(await mkdtemp(join(tmpdir(), "omo-memorian-runner-")))
  roots.push(root)
  return { root, identityPaths: buildIdentityPaths(root, IDENTITY) }
}

async function nudgeOnce(options: CreateAgentSessionOptions): Promise<void> {
  const result = await callNudge(options, CANDIDATE_PATH, "Drain nodes before a rollout.")
  if (result.isError) throw new Error(`nudge rejected: ${result.text}`)
}

function runnerOptions(
  identityPaths: MemoryIdentityPaths,
  overrides: Partial<ConstructorParameters<typeof MemorianGateRunner>[0]> = {},
): ConstructorParameters<typeof MemorianGateRunner>[0] {
  return {
    identityPaths,
    loadConfig: () => ({
      config: { categories: { quick: { model: "omo-mock/mock-1" } } },
      diagnostics: [],
      layers: [],
      sources: [],
    }),
    env: {},
    ...overrides,
  }
}

function launchInput(overrides: Partial<Parameters<MemorianGateRunner["launch"]>[0]> = {}) {
  return {
    sessionId: SESSION_ID,
    candidates: CANDIDATES,
    surfaced: new Set<string>(),
    maxItems: 2,
    transcript: [{ role: "user" as const, text: "how do we handle kubernetes rollouts" }],
    modelRegistry: registrySnapshot(),
    ...overrides,
  }
}

describe("MemorianGateRunner", () => {
  test("#given a gate child that calls nudge on a valid candidate #when the runner launches #then the validated nudge lands in the pending store", async () => {
    // given
    const { identityPaths } = await fixture()
    const stub = scriptedSession(nudgeOnce)
    const runner = new MemorianGateRunner(runnerOptions(identityPaths, { createSession: stub.createSession }))

    // when
    const pending = runner.launch(launchInput())
    stub.resolve()
    const result = await pending

    // then
    expect(result.status).toBe("nudged")
    expect(await new PendingNudges(identityPaths.recallPending).take(SESSION_ID, { currentEpoch: 0 })).toEqual([
      { path: CANDIDATE_PATH, hint: "Drain nodes before a rollout." },
    ])
  })

  test("#given a snapshotted registry on the input #when the ctx behind it is already disposed #then the launch still succeeds", async () => {
    // given: production hands the runner a registry captured synchronously at settle. The runner
    // holds no ctx-reading seam at all, so the snapshot is the whole story of how it resolves.
    const { identityPaths } = await fixture()
    const stub = scriptedSession(nudgeOnce)
    const runner = new MemorianGateRunner(runnerOptions(identityPaths, { createSession: stub.createSession }))

    // when
    const pending = runner.launch(launchInput({ modelRegistry: registrySnapshot() }))
    stub.resolve()
    const result = await pending

    // then
    expect(result.status).toBe("nudged")
    expect(await new PendingNudges(identityPaths.recallPending).take(SESSION_ID, { currentEpoch: 0 })).toEqual([
      { path: CANDIDATE_PATH, hint: "Drain nodes before a rollout." },
    ])
  })

  test("#given no registry snapshot on the input #when the runner launches #then it warns, skips and creates no child session", async () => {
    // given: the settle handler is the ONLY place allowed to read the senpi ctx. When its
    // synchronous snapshot came back unavailable the runner has no legal source left: consulting
    // a resolver here would read a ctx the host disposed the moment the handler returned.
    const { identityPaths } = await fixture()
    const stub = scriptedSession(nudgeOnce)
    const warnings: string[] = []
    const runner = new MemorianGateRunner(runnerOptions(identityPaths, {
      createSession: stub.createSession,
      logger: { info: () => undefined, warn: (message) => warnings.push(message), error: () => undefined },
    }))

    // when: the settle snapshot came back unavailable
    const result = await runner.launch(launchInput({ modelRegistry: undefined }))

    // then
    expect(result.status).toBe("skipped")
    expect(stub.created).toBe(0)
    expect(warnings).toEqual(["memorian gate registry snapshot unavailable"])
    expect(await new PendingNudges(identityPaths.recallPending).take(SESSION_ID, { currentEpoch: 0 })).toEqual([])
  })

  test("#given the quick category cannot resolve #when the runner launches #then it warns, skips and creates no child session", async () => {
    // given
    const { identityPaths } = await fixture()
    const stub = scriptedSession(nudgeOnce)
    const warnings: string[] = []
    const runner = new MemorianGateRunner(runnerOptions(identityPaths, {
      loadConfig: () => ({ config: { categories: {} }, diagnostics: [], layers: [], sources: [] }),
      createSession: stub.createSession,
      logger: { info: () => undefined, warn: (message) => warnings.push(message), error: () => undefined },
    }))

    // when
    const result = await runner.launch(launchInput({ modelRegistry: registrySnapshot([]) }))

    // then
    expect(result.status).toBe("skipped")
    expect(stub.created).toBe(0)
    expect(warnings).toHaveLength(1)
    expect(await new PendingNudges(identityPaths.recallPending).take(SESSION_ID, { currentEpoch: 0 })).toEqual([])
  })

  test("#given no quick category but another usable registry model #when the runner launches #then it warns, skips and never rides the beyond-category ladder", async () => {
    // given: resolveReflectionModel's beyond-category ladder resolves ANY usable registry model when
    // the quick chain is dead. The gate is quick-PINNED: an advisory read must never launch on an
    // arbitrary (possibly frontier-priced) model behind the operator's back.
    const { identityPaths } = await fixture()
    const stub = scriptedSession(nudgeOnce)
    const warnings: string[] = []
    const runner = new MemorianGateRunner(runnerOptions(identityPaths, {
      loadConfig: () => ({ config: { categories: {} }, diagnostics: [], layers: [], sources: [] }),
      createSession: stub.createSession,
      logger: { info: () => undefined, warn: (message) => warnings.push(message), error: () => undefined },
    }))

    // when
    const result = await runner.launch(launchInput({ modelRegistry: registrySnapshot([{ id: "expensive-1" }]) }))

    // then
    expect(result.status).toBe("skipped")
    expect(stub.created).toBe(0)
    expect(warnings).toEqual(["memorian gate quick category unavailable"])
    expect(await new PendingNudges(identityPaths.recallPending).take(SESSION_ID, { currentEpoch: 0 })).toEqual([])
  })

  test("#given a launch already in flight #when a second trigger arrives #then only one child session is created", async () => {
    // given: the first launch holds the latch until the test releases its turn.
    const { identityPaths } = await fixture()
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const stub = scriptedSession(async (options) => {
      await nudgeOnce(options)
      await gate
    })
    const runner = new MemorianGateRunner(runnerOptions(identityPaths, { createSession: stub.createSession }))

    // when: the second trigger arrives while the first turn is still open
    const first = runner.launch(launchInput())
    const second = runner.launch(launchInput())
    stub.resolve()
    release?.()
    const [firstResult, secondResult] = await Promise.all([first, second])

    // then
    expect(stub.created).toBe(1)
    expect([firstResult.status, secondResult.status].sort()).toEqual(["active", "nudged"])
  })

  test("#given a child that fabricates a path #when the nudge tool rejects it #then nothing is pending and the run is empty", async () => {
    // given
    const { identityPaths } = await fixture()
    const stub = scriptedSession(async (options) => {
      const rejected = await callNudge(options, "notes/never-offered.md", "nope")
      if (!rejected.isError) throw new Error("a fabricated path must be rejected")
    })
    const runner = new MemorianGateRunner(runnerOptions(identityPaths, { createSession: stub.createSession }))

    // when
    const pending = runner.launch(launchInput())
    stub.resolve()
    const result = await pending

    // then
    expect(result.status).toBe("empty")
    expect(await new PendingNudges(identityPaths.recallPending).take(SESSION_ID, { currentEpoch: 0 })).toEqual([])
  })

  test("#given a child session that cannot be created #when the runner launches #then the failure names the creation cause", async () => {
    // given
    const { identityPaths } = await fixture()
    const runner = new MemorianGateRunner(runnerOptions(identityPaths, {
      createSession: async () => {
        throw new Error("boot failed")
      },
    }))

    // when
    const result = await runner.launch(launchInput())

    // then
    expect(result).toMatchObject({ status: "failed", cause: "session_create_failed" })
    expect(await new PendingNudges(identityPaths.recallPending).take(SESSION_ID, { currentEpoch: 0 })).toEqual([])
  })

  test("#given a child turn that ends with an error #when the runner launches #then the failure names the child cause", async () => {
    // given: the turn's prompt itself rejects, so the handle records a typed child failure.
    const { identityPaths } = await fixture()
    const failing = scriptedSession(async () => {
      throw new Error("provider exploded")
    })
    const runner = new MemorianGateRunner(runnerOptions(identityPaths, { createSession: failing.createSession }))

    // when
    const result = await runner.launch(launchInput())

    // then
    expect(result).toMatchObject({ status: "failed", cause: "child_failed" })
    expect(await new PendingNudges(identityPaths.recallPending).take(SESSION_ID, { currentEpoch: 0 })).toEqual([])
  })

  test("#given a child that never settles #when the deadline fires #then the run fails with the deadline cause and no pending nudges", async () => {
    // given: the turn stays open forever; the abort deadline is the only way out.
    const { identityPaths } = await fixture()
    const hung = scriptedSession(() => new Promise<void>(() => undefined))
    const runner = new MemorianGateRunner(runnerOptions(identityPaths, {
      createSession: hung.createSession,
      deadlineMs: 200,
    }))

    // when
    const result = await runner.launch(launchInput())

    // then
    expect(result).toMatchObject({ status: "failed", cause: "deadline" })
    expect(await new PendingNudges(identityPaths.recallPending).take(SESSION_ID, { currentEpoch: 0 })).toEqual([])
  })

  test("#given a compaction accepted mid-flight #when the child finishes #then the stale nudges are discarded instead of written", async () => {
    // given: the child judged transcript T1; a compaction accepted while it ran rewrote that
    // transcript, so its verdict now advises a conversation that no longer exists.
    const { identityPaths } = await fixture()
    const stub = scriptedSession(nudgeOnce)
    const warnings: string[] = []
    let epoch = 7
    const runner = new MemorianGateRunner(runnerOptions(identityPaths, {
      createSession: stub.createSession,
      logger: { info: () => undefined, warn: (message) => warnings.push(message), error: () => undefined },
    }))

    // when: the epoch advances while the child runs
    const pending = runner.launch(launchInput({
      compactionEpoch: epoch,
      currentCompactionEpoch: () => {
        epoch = 8
        return epoch
      },
    }))
    stub.resolve()
    const result = await pending

    // then
    expect(result.status).toBe("dropped")
    expect(warnings).toEqual(["memorian gate nudges dropped after compaction"])
    expect(await new PendingNudges(identityPaths.recallPending).take(SESSION_ID, { currentEpoch: 0 })).toEqual([])
  })

  test("#given a launch epoch #when the nudges are written #then the payload carries that epoch", async () => {
    // given: the epoch travels IN the payload, so the consumer - not the writer - decides staleness
    const { identityPaths } = await fixture()
    const stub = scriptedSession(nudgeOnce)
    const seen: number[] = []
    const real = new PendingNudges(identityPaths.recallPending)
    const runner = new MemorianGateRunner(runnerOptions(identityPaths, {
      createSession: stub.createSession,
      pendingNudges: {
        write: async (sessionId, nudges, options) => {
          seen.push(options.epoch)
          await real.write(sessionId, nudges, options)
        },
        delete: (sessionId) => real.delete(sessionId),
      },
    }))

    // when
    const pending = runner.launch(launchInput({ compactionEpoch: 9, currentCompactionEpoch: () => 9 }))
    stub.resolve()
    const result = await pending

    // then
    expect(result.status).toBe("nudged")
    expect(seen).toEqual([9])
  })

  test("#given a compaction accepted DURING the pending write #when the write completes #then the landed file is retracted", async () => {
    // given: the pre-write epoch check passes, then write() awaits fs work. A compaction accepted in
    // that window bumps the epoch and its own pending-drop finds no file yet - so the rename lands a
    // pre-compaction nudge that nothing would ever remove. The runner must re-check AFTER the write.
    const { identityPaths } = await fixture()
    const stub = scriptedSession(nudgeOnce)
    const warnings: string[] = []
    const real = new PendingNudges(identityPaths.recallPending)
    let epoch = 4
    const runner = new MemorianGateRunner(runnerOptions(identityPaths, {
      createSession: stub.createSession,
      logger: { info: () => undefined, warn: (message) => warnings.push(message), error: () => undefined },
      pendingNudges: {
        write: async (sessionId, nudges, options) => {
          // The compaction lands while the write is still in flight: the epoch bumps here, and the
          // compaction's own pending-drop runs before this rename ever creates the file.
          epoch = 5
          await real.write(sessionId, nudges, options)
        },
        delete: (sessionId) => real.delete(sessionId),
      },
    }))

    // when
    const pending = runner.launch(launchInput({
      compactionEpoch: 4,
      currentCompactionEpoch: () => epoch,
    }))
    stub.resolve()
    const result = await pending

    // then
    expect(result.status).toBe("dropped")
    expect(warnings).toEqual(["memorian gate nudges dropped after compaction"])
    expect(existsSync(join(identityPaths.recallPending, `${SESSION_ID}.json`))).toBe(false)
    expect(await real.take(SESSION_ID, { currentEpoch: epoch })).toEqual([])
  })

  test("#given a compaction that lands mid-write and no post-write retraction #when the next turn takes #then the stale payload is never consumed", async () => {
    // given: the reviewer's exact interleaving. The pre-write check passes, write() yields, the
    // compaction bumps the epoch inside that yield and its own pending-drop finds no file, then the
    // rename lands. This store deliberately performs NO retraction at all, so only the consumption
    // point can reject the payload - which is what makes correctness independent of the race.
    const { identityPaths } = await fixture()
    const stub = scriptedSession(nudgeOnce)
    const real = new PendingNudges(identityPaths.recallPending)
    let epoch = 4
    const runner = new MemorianGateRunner(runnerOptions(identityPaths, {
      createSession: stub.createSession,
      pendingNudges: {
        write: async (sessionId, nudges, options) => {
          // Yield mid-write, exactly where rename has not happened yet.
          await Promise.resolve()
          epoch = 5
          await real.write(sessionId, nudges, options)
        },
        // The best-effort retraction is disabled: the epoch check at take() must stand alone.
        delete: async () => undefined,
      },
    }))

    // when
    const pending = runner.launch(launchInput({ compactionEpoch: 4, currentCompactionEpoch: () => epoch }))
    stub.resolve()
    await pending

    // then: the next turn reads the live (bumped) epoch and the pre-compaction verdict never lands
    expect(await real.take(SESSION_ID, { currentEpoch: epoch })).toEqual([])
    expect(existsSync(join(identityPaths.recallPending, `${SESSION_ID}.json`))).toBe(false)
  })

  test("#given an unchanged compaction epoch #when the child finishes #then the nudges are written as usual", async () => {
    // given
    const { identityPaths } = await fixture()
    const stub = scriptedSession(nudgeOnce)
    const runner = new MemorianGateRunner(runnerOptions(identityPaths, { createSession: stub.createSession }))

    // when
    const pending = runner.launch(launchInput({
      compactionEpoch: 3,
      currentCompactionEpoch: () => 3,
    }))
    stub.resolve()
    const result = await pending

    // then: the payload carries the launch epoch, so the next turn at epoch 3 consumes it
    expect(result.status).toBe("nudged")
    expect(await new PendingNudges(identityPaths.recallPending).take(SESSION_ID, { currentEpoch: 3 })).toEqual([
      { path: CANDIDATE_PATH, hint: "Drain nodes before a rollout." },
    ])
  })

  test("#given a completed run #when the runner finishes #then the run directory is kept with its auditable artifacts", async () => {
    // given: the run dir is no longer scratch - candidates and the transcript window stay behind as
    // human-auditable artifacts of what the judge actually saw (pruning is deliberately out of scope).
    const { identityPaths } = await fixture()
    const stub = scriptedSession(nudgeOnce)
    const runner = new MemorianGateRunner(runnerOptions(identityPaths, { createSession: stub.createSession }))

    // when
    const pending = runner.launch(launchInput())
    stub.resolve()
    await pending

    // then
    const runsDir = join(identityPaths.recall, "runs")
    const entries = await readdir(runsDir)
    expect(entries).toHaveLength(1)
    const runDir = join(runsDir, entries[0] ?? "")
    expect(JSON.parse(await readFile(join(runDir, "candidates.json"), "utf8"))).toMatchObject({
      version: 1,
      maxItems: 2,
      candidates: [{ path: CANDIDATE_PATH }],
      surfaced: [],
    })
    expect(await readFile(join(runDir, "transcript-window.txt"), "utf8"))
      .toBe("user: how do we handle kubernetes rollouts\n")
  })

  test("#given an inlined launch #when the child session is created #then the judge prompt carries the inputs inline with a bare envelope", async () => {
    // given: the child gets its inputs IN the user message and the persona as the system prompt, so
    // it needs no file access and the ancestry wrapper never wraps the memorian persona.
    const { identityPaths } = await fixture()
    const stub = scriptedSession(nudgeOnce)
    let captured: CreateAgentSessionOptions | undefined
    const createSession: CreateChildSession = async (options) => {
      captured = options
      return await stub.createSession(options)
    }
    const runner = new MemorianGateRunner(runnerOptions(identityPaths, { createSession }))

    // when
    const pending = runner.launch(launchInput())
    stub.resolve()
    await pending

    // then: the prompt is the input block itself, inlined
    expect(stub.promptTexts).toHaveLength(1)
    const prompt = stub.promptTexts[0] ?? ""
    expect(prompt).not.toContain("You are running as an omo senpi-task child")
    expect(prompt).toContain("<memorian-input>")
    expect(prompt).toContain(`"maxItems": 2`)
    expect(prompt).toContain(CANDIDATE_PATH)
    expect(prompt).toContain("user: how do we handle kubernetes rollouts")
    // and the child session runs the memorian persona as its system prompt with only the nudge tool
    expect(captured?.resourceLoader?.getSystemPrompt()).toContain("# Memorian — memory nudge agent")
    expect(captured?.tools).toEqual(["nudge"])
    const toolNames = (captured?.customTools ?? []).map((tool) => tool.name)
    expect(toolNames).toEqual(["nudge"])
  })
})
