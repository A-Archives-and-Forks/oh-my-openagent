import { existsSync } from "node:fs"
import { join } from "node:path"

import type { AgentToolResult, ToolDefinition } from "@code-yeongyu/senpi"
import {
  GitMemoryRepo,
  MemoryApplyPatchError,
  MemoryPatchHunkError,
  MemoryPatchParseError,
  MemoryToolError,
  buildDefaultSeedFiles,
  createLockRecord,
  installHooks,
  memoryWriterLockPath,
  runMemoryApplyPatch,
  runMemoryTool,
  withLock,
  type GitCommitAuthor,
  type MemoryToolLock,
} from "@oh-my-opencode/memory-core"
import { Type, type Static, type TSchema } from "typebox"

import type { SenpiExtensionAPI } from "../../extension/types"
import type { MemoryIdentityContext } from "./context"

export const MEMORY_TOOL_NAME = "memory"
export const MEMORY_APPLY_PATCH_TOOL_NAME = "memory_apply_patch"

const UNBOUND_IDENTITY_MESSAGE =
  "no memory identity bound to this session; enable omo memory and restart the session so the memory tools can initialize"

const MEMORY_TOOL_DESCRIPTION = [
  "A convenience tool for memories stored in the omo memory repo that automatically commits changes. The harness syncs clean committed memory changes after the turn.",
  "",
  "Memory files are markdown documents with YAML frontmatter. Frontmatter carries a `description` (required on create; it is what the memory index shows) and may set `read_only: \"true\"` to block modification. Edits preserve existing frontmatter.",
  "",
  "Supported operations on memory files:",
  "- `str_replace`",
  "- `insert`",
  "- `delete` (files, or directories recursively)",
  "- `rename` (path rename only)",
  "- `update_description`",
  "- `create`",
  "For larger reorganizations, use memory_apply_patch instead.",
  "",
  "Path formats accepted:",
  "- relative memory file paths (e.g. `system/contacts.md`, `reference/project/team.md`)",
  "- absolute paths only when they are inside the memory repo",
  "",
  "Note: absolute paths outside the memory repo are rejected.",
  "",
  "When creating or deleting files, check for `[[path]]` references in other memory files that may need to be added or updated. Keeping references consistent ensures future discoverability.",
  "",
  "On success the tool returns `Memory <command> committed locally (<sha>).`, or `Memory <command> committed (<sha>); harness will sync after the turn.` when a remote is configured. Commits are authored with the bound omo memory identity.",
  "",
  "Examples:",
  "",
  "```python",
  '# Replace text in a memory file',
  'memory(command="str_replace", reason="Update theme preference", file_path="system/human/preferences.md", old_string="theme: dark", new_string="theme: light")',
  "",
  "# Insert text at line 5",
  'memory(command="insert", reason="Add note about meeting", file_path="reference/history/meeting-notes.md", insert_line=5, insert_text="New note here")',
  "",
  "# Delete a memory file",
  'memory(command="delete", reason="Remove stale notes", file_path="reference/history/old_notes.md")',
  "",
  "# Rename a memory file",
  'memory(command="rename", reason="Promote temp notes", old_path="reference/history/temp.md", new_path="reference/history/permanent.md")',
  "",
  "# Update a block description",
  'memory(command="update_description", reason="Clarify coding prefs block", file_path="system/human/prefs/coding.md", description="The user\'s coding preferences.")',
  "",
  "# Create a block with starting text",
  'memory(command="create", reason="Track coding preferences", file_path="system/human/prefs/coding.md", description="The user\'s coding preferences.", file_text="The user adds type hints to all of their Python code.")',
  "```",
].join("\n")

const MEMORY_APPLY_PATCH_DESCRIPTION = [
  "Apply a codex-style patch to memory files in the omo memory repo, then automatically commit the change. The harness syncs clean committed memory changes after the turn.",
  "",
  "This is similar to `apply_patch`, but scoped to the memory repo and with memory-aware guardrails.",
  "",
  "- Required args:",
  "  - `reason` — git commit message for the memory change",
  "  - `input` — patch text using the standard apply_patch format",
  "",
  "Patch format:",
  "- `*** Begin Patch`",
  "- `*** Add File: <path>`",
  "- `*** Update File: <path>`",
  "  - optional `*** Move to: <path>`",
  "  - one or more `@@` hunks with ` `, `-`, `+` lines",
  "- `*** Delete File: <path>`",
  "- `*** End Patch`",
  "",
  "Path rules:",
  "- Relative paths are interpreted inside the memory repo",
  "- Absolute paths are allowed only when under the memory repo",
  "- Paths outside the memory repo are rejected",
  "",
  "Memory rules:",
  "- Operates on markdown memory files (`.md`) with YAML frontmatter",
  "- Updated/deleted files must be valid memory files with frontmatter",
  "- `read_only: \"true\"` files cannot be modified",
  "- If adding a file without frontmatter, frontmatter is created automatically",
  "",
  "Git behavior:",
  "- Stages changed memory paths",
  "- Commits with `reason`, authored by the bound omo memory identity (`<identity>@omo.local`)",
  "- Sync to a configured remote is handled by the harness after the turn",
  "",
  "On success the tool returns `memory_apply_patch committed locally (<sha>).`, or `memory_apply_patch committed (<sha>); harness will sync after the turn.` when a remote is configured.",
  "",
  "Example:",
  "```python",
  "memory_apply_patch(",
  '  reason="Refine coding preferences",',
  '  input="""*** Begin Patch',
  "*** Update File: system/human/prefs/coding.md",
  "@@",
  "-Use broad abstractions",
  "+Prefer small focused helpers",
  '*** End Patch"""',
  ")",
  "```",
].join("\n")

export const MemoryToolParams = Type.Object({
  command: Type.Union([
    Type.Literal("create"),
    Type.Literal("str_replace"),
    Type.Literal("insert"),
    Type.Literal("delete"),
    Type.Literal("rename"),
    Type.Literal("update_description"),
  ], { description: "The memory operation to perform." }),
  reason: Type.String({ description: "Git commit message recorded for this memory change." }),
  file_path: Type.Optional(Type.String({ description: "Target memory file: relative to the memory repo, or absolute inside it. Required by create, str_replace, insert, delete, and update_description." })),
  old_path: Type.Optional(Type.String({ description: "Current path of the memory file. Required by rename." })),
  new_path: Type.Optional(Type.String({ description: "Destination path of the memory file. Required by rename." })),
  old_string: Type.Optional(Type.String({ description: "Exact text to replace. Required by str_replace." })),
  new_string: Type.Optional(Type.String({ description: "Replacement text. Required by str_replace." })),
  insert_line: Type.Optional(Type.Number({ description: "1-based line number at which to insert text. Required by insert." })),
  insert_text: Type.Optional(Type.String({ description: "Text to insert. Required by insert." })),
  description: Type.Optional(Type.String({ description: "Frontmatter description of the memory block. Required by create and update_description." })),
  file_text: Type.Optional(Type.String({ description: "Initial body text for create." })),
})

export const MemoryApplyPatchParams = Type.Object({
  reason: Type.String({ description: "Git commit message recorded for this memory change." }),
  input: Type.String({ description: "Patch text in the standard apply_patch format (*** Begin Patch ... *** End Patch)." }),
})

export interface MemoryToolResultDetails {
  readonly message: string
}

// The agent loop honors an inline `isError` on the returned result (senpi builtin tool convention);
// the base AgentToolResult type does not declare it, so it is intersected on here.
export type MemoryToolExecutionResult = AgentToolResult<MemoryToolResultDetails> & { readonly isError?: boolean }

export type MemoryToolDefinition<TParams extends TSchema> = Omit<ToolDefinition<TParams, MemoryToolResultDetails>, "execute"> & {
  readonly execute: (toolCallId: string, params: Static<TParams>) => Promise<MemoryToolExecutionResult>
}

export interface MemoryToolsOptions {
  /** Writer-lock wait budget before contention is reported; defaults to 5000ms. */
  readonly lockWaitTimeoutMs?: number
  /** Writer-lock retry cadence while waiting; defaults to the memory-core default (25ms). */
  readonly lockRetryDelayMs?: number
}

export type MemoryContextResolver = () => MemoryIdentityContext | undefined

export function createMemoryTools(
  resolveContext: MemoryContextResolver,
  options: MemoryToolsOptions = {},
): readonly [MemoryToolDefinition<typeof MemoryToolParams>, MemoryToolDefinition<typeof MemoryApplyPatchParams>] {
  return [createMemoryTool(resolveContext, options), createMemoryApplyPatchTool(resolveContext, options)]
}

// Registration is cheap and always available; ACTIVATION is gated at execute time through the
// resolver (the session_start binding seam), so a stale invocation in an unbound session returns
// an actionable initialization error instead of failing to find the tool.
export function registerMemoryTools(
  pi: SenpiExtensionAPI,
  resolveContext: MemoryContextResolver,
  options: MemoryToolsOptions = {},
): void {
  for (const tool of createMemoryTools(resolveContext, options)) pi.registerTool({ ...tool })
}

function createMemoryTool(
  resolveContext: MemoryContextResolver,
  options: MemoryToolsOptions,
): MemoryToolDefinition<typeof MemoryToolParams> {
  return {
    name: MEMORY_TOOL_NAME,
    label: "Memory",
    description: MEMORY_TOOL_DESCRIPTION,
    promptSnippet: "memory - edit omo memory blocks (create/str_replace/insert/delete/rename/update_description); auto-commits each change",
    promptGuidelines: [
      "Record durable facts, preferences, and decisions with the memory tool as you learn them; every change is committed with the reason you provide.",
      "Memory files are markdown with YAML frontmatter; keep each block's description accurate because the memory index surfaces it.",
      "When creating, renaming, or deleting memory files, update [[path]] references in other memory files so they stay discoverable.",
    ],
    parameters: MemoryToolParams,
    executionMode: "sequential",
    execute: async (_toolCallId, params) => {
      const context = resolveContext()
      if (context === undefined) return errorResult(`${MEMORY_TOOL_NAME}: ${UNBOUND_IDENTITY_MESSAGE}`)
      try {
        const { repo, lock, author } = await prepareEngine(context, options)
        const result = await runMemoryTool({ repo, lock, params: { ...params, author } })
        return okResult(result.message)
      } catch (error) {
        if (error instanceof MemoryToolError) return errorResult(error.message)
        throw error
      }
    },
  }
}

function createMemoryApplyPatchTool(
  resolveContext: MemoryContextResolver,
  options: MemoryToolsOptions,
): MemoryToolDefinition<typeof MemoryApplyPatchParams> {
  return {
    name: MEMORY_APPLY_PATCH_TOOL_NAME,
    label: "Memory Apply Patch",
    description: MEMORY_APPLY_PATCH_DESCRIPTION,
    promptSnippet: "memory_apply_patch - apply a codex-style patch to omo memory files; auto-commits the change",
    promptGuidelines: [
      "Use memory_apply_patch for multi-file or multi-hunk memory edits; prefer the memory tool for single-block changes.",
      "Patches may only target paths inside the memory repo, and read_only memory files cannot be modified.",
    ],
    parameters: MemoryApplyPatchParams,
    executionMode: "sequential",
    execute: async (_toolCallId, params) => {
      const context = resolveContext()
      if (context === undefined) return errorResult(`${MEMORY_APPLY_PATCH_TOOL_NAME}: ${UNBOUND_IDENTITY_MESSAGE}`)
      try {
        const { repo, lock, author } = await prepareEngine(context, options)
        const result = await runMemoryApplyPatch({ repo, lock, params: { ...params, author } })
        return okResult(result.message)
      } catch (error) {
        if (
          error instanceof MemoryApplyPatchError
          || error instanceof MemoryPatchParseError
          || error instanceof MemoryPatchHunkError
        ) {
          return errorResult(error.message)
        }
        throw error
      }
    },
  }
}

interface MemoryEngineDeps {
  readonly repo: GitMemoryRepo
  readonly lock: MemoryToolLock
  readonly author: GitCommitAuthor
}

async function prepareEngine(context: MemoryIdentityContext, options: MemoryToolsOptions): Promise<MemoryEngineDeps> {
  // First-write seam: runtime dirs (including the locks directory) must exist before the writer
  // lock publishes into them; reads never create identity storage.
  await context.repoAccess.ensureRuntimeDirs()
  const repo = new GitMemoryRepo({ dir: context.identityPaths.repo, agentId: context.identity })
  const lock = createWriterLock(context, options)
  if (!existsSync(join(context.identityPaths.repo, ".git"))) {
    await lock("memory-write", async () => {
      if (!existsSync(join(context.identityPaths.repo, ".git"))) {
        await repo.init({ seedFiles: buildDefaultSeedFiles(), installHooks: (dir) => { installHooks(dir) } })
      }
    })
  }
  return {
    repo,
    lock,
    author: { agentId: context.identity, authorName: context.identity },
  }
}

function createWriterLock(context: MemoryIdentityContext, options: MemoryToolsOptions): MemoryToolLock {
  return async (domain, operation) => {
    if (domain !== "memory-write") throw new MemoryToolError(`unsupported lock domain '${domain}'`)
    const record = await createLockRecord(`memory tool (${context.identity})`)
    return withLock(memoryWriterLockPath(context.identityPaths.locks), record, operation, {
      waitTimeoutMs: options.lockWaitTimeoutMs ?? 5_000,
      ...(options.lockRetryDelayMs === undefined ? {} : { retryDelayMs: options.lockRetryDelayMs }),
    })
  }
}

function okResult(message: string): MemoryToolExecutionResult {
  return { content: [{ type: "text", text: message }], details: { message } }
}

function errorResult(message: string): MemoryToolExecutionResult {
  return { content: [{ type: "text", text: message }], details: { message }, isError: true }
}
