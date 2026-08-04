import type { CreateAgentSessionOptions, SessionManager, ToolDefinition } from "@code-yeongyu/senpi"

import { CURATED_READONLY_AGENT_NAMES } from "../../agents/builtin"
import type { ChildSpec } from "../in-process"
import { createChildResourceLoader } from "./child-loader"
import { createCuratedReadonlyBashTool } from "./curated-readonly-bash"
import { RunnerError } from "./runner-error"
import { createRuntimeFallbackSettings } from "./runtime-fallback-settings"
import { mergeChildCustomTools } from "./shared-tool-filter"

export type BuildChildSessionOptionsInput = {
  readonly spec: ChildSpec
  // The caller owns session-lifecycle: start passes SessionManager.create(cwd, spec.sessionDir),
  // resume (todo 10) passes SessionManager.open(sessionPath, spec.sessionDir, cwd). Everything else
  // about the child's construction is assembled here so both modes share ONE option builder.
  readonly sessionManager: SessionManager
  readonly sharedParentTools: readonly ToolDefinition[]
  readonly uiOnlyToolNames: readonly string[]
}

/**
 * The child session dir is MANDATORY: a legacy spec without one must fail typed, never fall back
 * to senpi's default (~/.senpi) location or an in-memory session - either would strand the
 * transcript outside stateDir/children/<taskId>/ where reconcile discovery looks.
 */
export function requireChildSessionDir(spec: ChildSpec): string {
  if (typeof spec.sessionDir !== "string" || spec.sessionDir.length === 0) {
    throw new RunnerError({
      kind: "session-create-failed",
      message: `Child ${spec.taskId} has no sessionDir; refusing to fall back to a default session location.`,
    })
  }
  return spec.sessionDir
}

/**
 * Assemble the full CreateAgentSessionOptions for an in-process child: shared parent tools minus
 * the task/team family, member-scoped tools (the sanctioned bypass), the curated read-only bash
 * override, the allowlist on `tools`, the denylist on senpi's real deny field `excludeTools`
 * (`tools:` alone does NOT deny), runtime fallback settings, and model/auth/runtime passthroughs.
 */
export function buildChildSessionOptions(input: BuildChildSessionOptionsInput): CreateAgentSessionOptions {
  const { spec, sessionManager, uiOnlyToolNames } = input
  const mergedCustomTools = mergeChildCustomTools(input.sharedParentTools, spec.memberScopedTools, {
    uiOnlyToolNames,
  })
  const customTools = spec.agentType !== undefined && CURATED_READONLY_AGENT_NAMES.has(spec.agentType)
    ? [...mergedCustomTools.filter((tool) => tool.name !== "bash"), createCuratedReadonlyBashTool(spec.cwd)]
    : mergedCustomTools
  const settingsManager = createRuntimeFallbackSettings(spec.selectedModel, spec.fallbackModels)
  return {
    cwd: spec.cwd,
    sessionManager,
    resourceLoader: createChildResourceLoader(),
    customTools,
    ...(spec.agentDir !== undefined && { agentDir: spec.agentDir }),
    ...(spec.authStorage !== undefined && { authStorage: spec.authStorage }),
    ...(spec.modelRegistry !== undefined && { modelRegistry: spec.modelRegistry }),
    ...(spec.modelRuntime !== undefined && { modelRuntime: spec.modelRuntime }),
    ...(spec.model !== undefined && { model: spec.model }),
    ...(spec.thinkingLevel !== undefined && { thinkingLevel: spec.thinkingLevel }),
    settingsManager,
    ...(spec.toolAllowlist !== undefined && { tools: [...spec.toolAllowlist] }),
    ...(spec.toolDenylist !== undefined && { excludeTools: [...spec.toolDenylist] }),
  }
}
