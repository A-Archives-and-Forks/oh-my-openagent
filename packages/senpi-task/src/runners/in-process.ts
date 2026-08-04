import { createAgentSession, SessionManager, type CreateAgentSessionOptions, type ToolDefinition } from "@code-yeongyu/senpi"

import type { ResolvedModelRecord } from "../state"
import { createChildHandle, type ChildHandle, type ChildSession } from "./in-process/child-handle"
import { buildChildSessionOptions, requireChildSessionDir } from "./in-process/child-options"
import { RunnerError } from "./in-process/runner-error"
import { buildSubagentPrompt } from "./in-process/subagent-prompt"

export type {
  ChildHandle,
  ChildSession,
  ChildSessionEvent,
  ChildSessionListener,
  RunnerFailure,
  RunnerOutcome,
} from "./in-process/child-handle"
export {
  filterSharedParentTools,
  isTaskOrTeamFamilyTool,
  mergeChildCustomTools,
  type SharedToolFilterOptions,
} from "./in-process/shared-tool-filter"
export { RunnerError } from "./in-process/runner-error"

export const DEFAULT_MAX_CHILD_DEPTH = 4

export type DepthPolicy = {
  readonly maxDepth: number
}

// Per-child construction spec. `model`, `authStorage`, `modelRegistry` reuse senpi's own option
// types so the parent's auth/models resolve normally against the parent's real agentDir.
export type ChildSpec = {
  readonly taskId: string
  readonly cwd: string
  // Isolated persistence dir for the child's JSONL transcript:
  // resolveChildSessionDir(join(stateDir, "children", taskId), taskId), shared with the rpc mode so
  // reconcile's newestSessionPath discovers both modes identically. REQUIRED - a missing dir is a
  // typed session-create-failed, never a silent inMemory/default-dir fallback.
  readonly sessionDir: string
  readonly agentDir?: string
  readonly authStorage?: CreateAgentSessionOptions["authStorage"]
  readonly modelRegistry?: CreateAgentSessionOptions["modelRegistry"]
  readonly modelRuntime?: CreateAgentSessionOptions["modelRuntime"]
  readonly model?: CreateAgentSessionOptions["model"]
  readonly thinkingLevel?: CreateAgentSessionOptions["thinkingLevel"]
  readonly selectedModel?: string
  readonly requestedModel?: ResolvedModelRecord
  readonly fallbackModels?: readonly ResolvedModelRecord[]
  readonly toolAllowlist?: readonly string[]
  // Denylist mapped onto senpi's real deny field `excludeTools` (`tools:` is the allowlist and does
  // NOT deny). Sourced from record.tool_deny (the agent definition's disallowedTools).
  readonly toolDenylist?: readonly string[]
  // Names of the member-scoped tools, carried for persistence so a later resume can re-resolve
  // them against the live shared parent tools (todo 10). Start uses `memberScopedTools` directly.
  readonly memberScopedToolNames?: readonly string[]
  // executable ToolDefinitions merged AFTER the shared-tool family filter - the ONLY sanctioned
  // bypass of the task/team-family exclusion (team layer injects the pre-scoped member tool here).
  readonly memberScopedTools?: readonly ToolDefinition[]
  readonly depth: number
  readonly parentSessionId: string
  readonly rootSessionId: string
  readonly agentType?: string
  readonly instructions?: string
  readonly prompt: string
}

export type CreateChildSession = (options: CreateAgentSessionOptions) => Promise<ChildSession>

export type InProcessRunnerOptions = {
  // The parent extension's registered ToolDefinitions (same-process, same execute closures). The
  // task/team family and any UI-rendering-only names are excluded before reaching a child.
  readonly sharedParentTools?: readonly ToolDefinition[]
  readonly uiOnlyToolNames?: Iterable<string>
  readonly depthPolicy?: DepthPolicy
  readonly createSession?: CreateChildSession
}

const defaultCreateChildSession: CreateChildSession = async (options) => (await createAgentSession(options)).session

export class InProcessRunner {
  readonly #sharedParentTools: readonly ToolDefinition[]
  readonly #uiOnlyToolNames: readonly string[]
  readonly #depthPolicy: DepthPolicy
  readonly #createSession: CreateChildSession

  constructor(options: InProcessRunnerOptions = {}) {
    this.#sharedParentTools = options.sharedParentTools ?? []
    this.#uiOnlyToolNames = [...(options.uiOnlyToolNames ?? [])]
    this.#depthPolicy = options.depthPolicy ?? { maxDepth: DEFAULT_MAX_CHILD_DEPTH }
    this.#createSession = options.createSession ?? defaultCreateChildSession
  }

  async start(spec: ChildSpec): Promise<ChildHandle> {
    if (spec.depth > this.#depthPolicy.maxDepth) {
      throw new RunnerError({
        kind: "depth-exceeded",
        message: `Child depth ${spec.depth} exceeds max depth ${this.#depthPolicy.maxDepth}.`,
      })
    }

    let session: ChildSession
    try {
      const options = buildChildSessionOptions({
        spec,
        sessionManager: SessionManager.create(spec.cwd, requireChildSessionDir(spec)),
        sharedParentTools: this.#sharedParentTools,
        uiOnlyToolNames: this.#uiOnlyToolNames,
      })
      session = await this.#createSession(options)
    } catch (error) {
      if (RunnerError.is(error)) throw error
      throw new RunnerError({ kind: "session-create-failed", message: sessionCreateMessage(error), cause: error })
    }

    const promptText = buildSubagentPrompt({
      taskId: spec.taskId,
      parentSessionId: spec.parentSessionId,
      rootSessionId: spec.rootSessionId,
      depth: spec.depth,
      prompt: spec.prompt,
      ...(spec.agentType !== undefined && { agentType: spec.agentType }),
      ...(spec.instructions !== undefined && { instructions: spec.instructions }),
    })

    return createChildHandle({ taskId: spec.taskId, session, promptText })
  }
}

function sessionCreateMessage(error: unknown): string {
  return `Failed to create in-process child session: ${error instanceof Error ? error.message : String(error)}`
}
