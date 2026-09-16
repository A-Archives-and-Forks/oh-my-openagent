import type { ToolDefinition } from "@code-yeongyu/senpi"

import { CURATED_READONLY_AGENT_NAMES } from "../../agents/builtin"
import { kernelToolKey } from "../../kernel-tools/names"
import { createKernelToolWrappers, type KernelToolWrapperOptions } from "../../kernel-tools/wrapper"
import type { ChildSpec } from "../in-process"
import { RunnerError } from "./runner-error"

/**
 * The child's parent-kernel tool surface. The tool layer already refused every unauthorised grant
 * before a session existed; this is the runner-side floor, so an in-process rebuild can never widen
 * a curated child or shadow a tool the child already has.
 */
export function buildChildKernelTools(
  spec: ChildSpec,
  existingToolNames: readonly string[],
  options: KernelToolWrapperOptions = {},
): ToolDefinition[] {
  const grant = spec.kernelTools
  if (grant === undefined) return []
  if (spec.agentType !== undefined && CURATED_READONLY_AGENT_NAMES.has(spec.agentType)) {
    throw new RunnerError({
      kind: "tools_unavailable",
      message: `Curated read-only agent "${spec.agentType}" must not receive parent kernel tools.`,
    })
  }
  const existing = new Set(existingToolNames.map(kernelToolKey))
  for (const descriptor of grant.descriptors) {
    if (existing.has(kernelToolKey(descriptor.name))) {
      throw new RunnerError({
        kind: "tools_unavailable",
        message: `Parent kernel tool "${descriptor.name}" collides with an existing tool of child ${spec.taskId}.`,
      })
    }
  }
  return createKernelToolWrappers(grant, options)
}
