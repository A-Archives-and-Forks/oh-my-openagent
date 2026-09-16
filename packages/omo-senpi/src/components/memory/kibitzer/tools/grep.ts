import { lstat, readdir, readFile, realpath, stat } from "@oh-my-opencode/memory-core/fs"
import { join, relative } from "node:path"
import { Type, type Static } from "typebox"

import type { WakeToolBudget } from "./budget"
import type { KibitzerToolCaps } from "./caps"
import { resolveWorkspacePath } from "./path-safety"
import { boundedText, budgeted, okJson, rejection, type KibitzerSidecarTool } from "./result"

export const KIBITZER_GREP_TOOL_NAME = "grep"

export const KibitzerGrepParams = Type.Object({
  pattern: Type.String({ description: "JavaScript regular expression matched against each line." }),
  path: Type.Optional(Type.String({ description: "File or directory relative to the workspace root; defaults to the root." })),
  ignore_case: Type.Optional(Type.Boolean({ description: "Case-insensitive match." })),
}, { additionalProperties: false })

export interface KibitzerGrepToolInput {
  readonly workspaceRoot: string
  readonly caps: KibitzerToolCaps
  readonly budget: () => WakeToolBudget
  /** Wall-clock source for the scan budget; injectable so tests do not sleep. */
  readonly now?: () => number
}

export interface KibitzerGrepMatch {
  readonly path: string
  readonly line: number
  readonly text: string
}

/** Why a scan ended early. Reported as `stopped` next to `truncated: true`. */
export type KibitzerGrepStopReason = "files" | "bytes" | "time" | "matches" | "aborted"

const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([".git", "node_modules"])
const MAX_FILE_BYTES = 1024 * 1024

interface ScanContext {
  readonly caps: KibitzerToolCaps
  readonly now: () => number
  readonly deadline: number
  readonly signal: AbortSignal | undefined
}

interface Candidates {
  readonly files: readonly string[]
  readonly stopped?: KibitzerGrepStopReason
}

interface GrepFileOutcome {
  /** Bytes actually read from this file (0 when it was skipped before the read). */
  readonly bytes: number
  /** True when the match cap was reached while scanning this file. */
  readonly capped: boolean
}

const SKIPPED_FILE: GrepFileOutcome = { bytes: 0, capped: false }

/**
 * A member-scoped grep over the workspace: the walk never follows symlinks, skips VCS/dependency
 * trees and binary or oversize files, and stops at the match cap. senpi withholds its builtin grep
 * from children, and a builtin would bypass the budget and the redaction anyway.
 *
 * The scan is bounded three more ways, because a rarely matching pattern over a large workspace used
 * to read every readable byte in it long after the wake that asked for it was gone: a file-count
 * budget, a byte budget over what was actually read, and a wall-clock budget (`caps.grepScan*`), plus
 * the turn's AbortSignal, checked per directory while enumerating and before every file. The first
 * limit that trips ends the scan; the matches gathered so far are kept and `stopped` names the limit.
 */
export function createKibitzerGrepTool(input: KibitzerGrepToolInput): KibitzerSidecarTool<typeof KibitzerGrepParams> {
  const description =
    `Search workspace files by regular expression (at most ${input.caps.grepMatches} matching lines). ` +
    `The scan is bounded (${input.caps.grepScanFiles} files, ` +
    `${Math.round(input.caps.grepScanBytes / (1024 * 1024))}MB read, ${Math.round(input.caps.grepScanMs / 1000)}s) and stops when the turn is ` +
    'cancelled; a bounded run returns "truncated": true with "stopped" naming the limit it hit.'
  return {
    name: KIBITZER_GREP_TOOL_NAME,
    label: "Kibitzer grep",
    description,
    parameters: KibitzerGrepParams,
    execute: budgeted(input.budget, async (params: Static<typeof KibitzerGrepParams>, signal?: AbortSignal) => {
      let pattern: RegExp
      try {
        pattern = new RegExp(params.pattern, params.ignore_case === true ? "i" : "")
      } catch (error) {
        return rejection("invalid_pattern", error instanceof Error ? error.message : String(error))
      }
      const resolved = await resolveWorkspacePath(input.workspaceRoot, params.path ?? ".")
      if (!resolved.ok) return rejection(resolved.code, resolved.message, params.path)
      let info
      try {
        info = await stat(resolved.path)
      } catch {
        return rejection("not_found", `"${params.path ?? "."}" does not exist.`, params.path)
      }
      const root = await realpath(input.workspaceRoot)
      const now = input.now ?? Date.now
      const context: ScanContext = { caps: input.caps, now, deadline: now() + input.caps.grepScanMs, signal }
      const candidates = info.isFile()
        ? ({ files: [resolved.path] } satisfies Candidates)
        : await walk(resolved.path, context)

      const matches: KibitzerGrepMatch[] = []
      let stopped = candidates.stopped
      let bytes = 0
      for (const file of candidates.files) {
        if (context.signal?.aborted === true) {
          stopped ??= "aborted"
          break
        }
        if (bytes >= input.caps.grepScanBytes) {
          stopped ??= "bytes"
          break
        }
        if (now() >= context.deadline) {
          stopped ??= "time"
          break
        }
        const outcome = await grepFile(file, relative(root, file), pattern, matches, input.caps)
        bytes += outcome.bytes
        if (outcome.capped) {
          stopped ??= "matches"
          break
        }
      }
      return okJson(stopped === undefined ? { matches, truncated: false } : { matches, truncated: true, stopped })
    }),
  }
}

async function walk(directory: string, context: ScanContext): Promise<Candidates> {
  const files: string[] = []
  const pending = [directory]
  let stopped: KibitzerGrepStopReason | undefined
  while (pending.length > 0) {
    if (context.signal?.aborted === true) {
      stopped = "aborted"
      break
    }
    if (context.now() >= context.deadline) {
      stopped = "time"
      break
    }
    const current = pending.pop() as string
    const entries = (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))
    let overflowed = false
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) pending.push(full)
      } else if (entry.isFile()) {
        files.push(full)
        // One past the budget is enough to know the tree does not fit; `bounded` cuts it back.
        if (files.length > context.caps.grepScanFiles) {
          overflowed = true
          break
        }
      }
    }
    if (overflowed) break
  }
  const result = bounded(files, context.caps.grepScanFiles)
  return stopped === undefined ? result : { files: result.files, stopped }
}

function bounded(files: string[], limit: number): Candidates {
  files.sort((a, b) => a.localeCompare(b))
  return files.length <= limit ? { files } : { files: files.slice(0, limit), stopped: "files" }
}

async function grepFile(
  file: string,
  displayPath: string,
  pattern: RegExp,
  matches: KibitzerGrepMatch[],
  caps: KibitzerToolCaps,
): Promise<GrepFileOutcome> {
  // lstat, not stat: the walk yields regular files, for which the two agree, and a candidate can
  // still vanish between the walk and the read.
  let info
  try {
    info = await lstat(file)
  } catch {
    return SKIPPED_FILE
  }
  if (!info.isFile() || info.size > MAX_FILE_BYTES) return SKIPPED_FILE
  let buffer: Buffer
  try {
    buffer = await readFile(file)
  } catch {
    return SKIPPED_FILE
  }
  const outcome: GrepFileOutcome = { bytes: buffer.byteLength, capped: false }
  if (buffer.subarray(0, 8192).includes(0)) return outcome
  const lines = buffer.toString("utf8").split("\n")
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string
    if (!pattern.test(line)) continue
    if (matches.length >= caps.grepMatches) return { bytes: outcome.bytes, capped: true }
    matches.push({ path: displayPath.split("\\").join("/"), line: index + 1, text: boundedText(line, caps.grepLineChars) })
  }
  return outcome
}
