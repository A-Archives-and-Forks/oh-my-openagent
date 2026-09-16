import { isTaskOrTeamFamilyTool } from "../runners/in-process/shared-tool-filter"

/**
 * Nested host calls made INSIDE a granted parent closure run with the PARENT session's tool
 * permissions: the merged producer exposes no scoped-execution hook for them (backlog senpi#1731).
 * Until it does, a grant must never hand a child a closure that reaches a WRITE-capable tool the
 * child's OWN policy took away.
 *
 * THE RULE (also stated in the changelog fragment and the PR body):
 *
 * - The child's effective host tool set is built exactly as the runner builds the child's tools:
 *   shared parent tools (plus the engine's own write-capable builtins) - UI-only names - task/team
 *   family - denylist, intersected with the allowlist whenever the resolved agent DEFINES one, even
 *   an empty one.
 * - The grant is REFUSED as `tools_unavailable` when the parent host surface the closure can reach
 *   is a proper superset of that set in a WRITE-capable way - that is, when the child's own
 *   allow/deny removes any write-capable name the parent can still reach.
 * - A name that is not on the known read-only/interaction list counts as WRITE-capable, so an
 *   unrecognised MCP or extension tool fails closed.
 * - Host-wide exclusions are NOT refusals. The UI/identity-bound tools (`memory`,
 *   `ask_user_question`, `request_user_input`) and the task/team family are withheld from EVERY
 *   child because they bind to the parent session's identity/UI or would let a child spawn its own
 *   graph - never as a reduction of what the child is permitted to cause. A parent-authored closure
 *   may therefore still reach them on the parent bridge; that residual is documented rather than
 *   refused, because refusing it would deny the shipped default `agent()` child every grant.
 */

// Host tools that only read or ask the user. `lsp_rename`/`lsp_prepare_rename` are deliberately
// absent: a rename edits files.
const READ_ONLY_HOST_TOOL_NAMES: ReadonlySet<string> = new Set([
  "read",
  "find",
  "grep",
  "glob",
  "ls",
  "list",
  "lsp_diagnostics",
  "lsp_goto_definition",
  "lsp_find_references",
  "lsp_symbols",
  "web_search",
  "web_fetch",
  "webfetch",
  "x_search",
  "tool_search",
  "ask_user_question",
  "request_user_input",
])

// The engine's own write-capable builtins. They are NOT extension tools, so they never appear in
// the shared parent tool list a host can enumerate - yet both the parent and an unrestricted child
// hold them, and a child's `tools:`/`excludeTools` policy can take them away. They are therefore
// always part of the surface this rule reasons about.
const ENGINE_WRITE_CAPABLE_HOST_TOOLS: readonly string[] = ["write", "edit", "bash"]

export function isWriteCapableHostTool(name: string): boolean {
  return !READ_ONLY_HOST_TOOL_NAMES.has(name)
}

export type NestedHostScopeRequest = {
  /**
   * The child's tool names BEFORE its own allow/deny is applied: shared parent tools minus the
   * UI-only names minus the task/team family. The engine's write-capable builtins are always
   * added, so a caller that can only enumerate extension tools (or none at all) still gets the
   * fail-closed answer.
   */
  readonly childToolNames?: readonly string[]
  readonly toolAllowlist?: readonly string[]
  readonly toolDenylist?: readonly string[]
}

// The parent host surface a granted closure can reach that the child is structurally offered too.
function reachableHostTools(request: NestedHostScopeRequest): readonly string[] {
  return [...new Set([...ENGINE_WRITE_CAPABLE_HOST_TOOLS, ...(request.childToolNames ?? [])])]
    .filter((name) => !isTaskOrTeamFamilyTool(name))
}

/**
 * The child's RESOLVED EFFECTIVE tool set: the same names the runner ends up installing, after the
 * allowlist (`tools:`) and the denylist (`excludeTools`) are applied to its structurally-visible
 * surface. A PRESENT allowlist narrows even when it is EMPTY - an empty allowlist is the most
 * restrictive shape there is (an omo.json agent written as `tools: { write: false }` resolves to
 * exactly that), so it is never read as "no policy".
 */
export function childEffectiveToolNames(request: NestedHostScopeRequest): readonly string[] {
  const allowlist = request.toolAllowlist === undefined ? undefined : new Set(request.toolAllowlist)
  const denylist = new Set(request.toolDenylist ?? [])
  return reachableHostTools(request)
    .filter((name) => !denylist.has(name) && (allowlist === undefined || allowlist.has(name)))
}

/**
 * The WRITE-capable parent tools the closure can reach that the child's effective set lacks. Empty
 * means the nested host calls cannot exceed what the child itself may cause, so the grant is safe.
 */
export function escalatingHostTools(request: NestedHostScopeRequest): readonly string[] {
  if (request.toolAllowlist === undefined && (request.toolDenylist?.length ?? 0) === 0) return []
  const effective = new Set(childEffectiveToolNames(request))
  return reachableHostTools(request).filter((name) => isWriteCapableHostTool(name) && !effective.has(name))
}

export function nestedHostScopeMessage(subject: string, escalating: readonly string[]): string {
  return `${subject} cannot receive parent kernel tools: a parent closure's nested host calls run with the PARENT's permissions, which still reach ${escalating.join(", ")} after this child's own tool policy removed ${escalating.length === 1 ? "it" : "them"}.`
}
