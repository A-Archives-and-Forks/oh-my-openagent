import { readFile, writeFile, mkdir } from "node:fs/promises"
import { join, relative, resolve, sep } from "node:path"

import {
  createLockRecord,
  skillsUsageLockPath,
  withLock,
  type MemoryIdentityPaths,
} from "@oh-my-opencode/memory-core"

import type { SenpiExtensionAPI } from "../../extension/types"
import type { ComponentLogger } from "../../extension/types"
import type { MemoryIdentityContext } from "./context"

/**
 * Skills-usage ledger entry: per skill-id, a read count and last-used timestamp.
 */
export interface SkillUsageEntry {
  readonly count: number
  readonly lastUsedAt: string
}

export type SkillsUsageLedger = Readonly<Record<string, SkillUsageEntry>>

/**
 * File-read tool names the ledger tracks. Matches the guard.ts FILE_TOOL_NAMES
 * classification (read-only tools that consume skill files).
 */
const READ_TOOL_NAMES = ["read", "cat", "less"] as const

/**
 * Path argument names the ledger inspects, matching guard.ts PATH_ARGUMENT_NAMES.
 */
const PATH_ARGUMENT_NAMES = ["path", "filePath", "file_path", "target"] as const

const DEBOUNCE_MS = 500
const LOCK_WAIT_MS = 2000

export interface SkillsUsageLedgerPath {
  readonly ledgerPath: string
  readonly lockPath: string
}

export function skillsUsagePaths(identityPaths: MemoryIdentityPaths): SkillsUsageLedgerPath {
  return {
    ledgerPath: join(identityPaths.runtime, "skills-usage.json"),
    lockPath: skillsUsageLockPath(identityPaths.locks),
  }
}

/**
 * Extracts the skill id from a file path that targets `<memfs repo>/skills/<name>/**`.
 * Returns undefined when the path does not resolve inside the skills directory.
 */
export function extractSkillId(repoDir: string, rawPath: string): string | undefined {
  if (rawPath.length === 0 || rawPath.includes("\0")) return undefined
  const absolute = resolve(rawPath)
  const rel = relative(repoDir, absolute)
  if (rel.startsWith("..")) return undefined
  const segments = rel.split(sep)
  if (segments.length < 2 || segments[0] !== "skills") return undefined
  return segments[1]
}

/**
 * Reads the current ledger from disk. Returns an empty object when the file
 * is absent or unreadable (the write never blocks or fails the tool).
 */
export async function readSkillsUsageLedger(ledgerPath: string): Promise<SkillsUsageLedger> {
  try {
    const content = await readFile(ledgerPath, "utf8")
    return parseLedger(content)
  } catch {
    return {}
  }
}

/**
 * Increments the usage count for a skill under the identity-scoped skills-usage lock,
 * using merge-under-lock (read, increment, write) so concurrent sessions bound to the
 * same identity never lose increments.
 *
 * Never throws: write failures are logged and swallowed so the tool is never blocked.
 */
export async function incrementSkillUsage(
  paths: SkillsUsageLedgerPath,
  skillId: string,
  now: () => Date,
  logger?: ComponentLogger,
): Promise<void> {
  const record = await createLockRecord("skills-usage")
  try {
    await withLock(
      paths.lockPath,
      record,
      async () => {
        const current = await readSkillsUsageLedger(paths.ledgerPath)
        const entry = current[skillId]
        const updated: SkillsUsageLedger = {
          ...current,
          [skillId]: {
            count: (entry?.count ?? 0) + 1,
            lastUsedAt: now().toISOString(),
          },
        }
        await mkdir(join(paths.ledgerPath, ".."), { recursive: true })
        await writeLedgerAtomic(paths.ledgerPath, updated)
      },
      { waitTimeoutMs: LOCK_WAIT_MS },
    )
  } catch (error) {
    logger?.warn("skills-usage ledger write failed", { skillId, error: String(error) })
  }
}

async function writeLedgerAtomic(ledgerPath: string, ledger: SkillsUsageLedger): Promise<void> {
  const tmp = `${ledgerPath}.tmp`
  await writeFile(tmp, JSON.stringify(ledger, null, 2), "utf8")
  const { rename } = await import("node:fs/promises")
  await rename(tmp, ledgerPath)
}

function parseLedger(content: string): SkillsUsageLedger {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return {}
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {}
  const result: Record<string, SkillUsageEntry> = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue
    const entry = value as Record<string, unknown>
    if (typeof entry.count !== "number" || typeof entry.lastUsedAt !== "string") continue
    result[key] = { count: entry.count, lastUsedAt: entry.lastUsedAt }
  }
  return result
}

/**
 * Debounced writer: batches increment calls within DEBOUNCE_MS into a single
 * locked read-modify-write cycle, so rapid sequential reads of the same or
 * different skills coalesce without losing any increment.
 */
export class SkillsUsageTracker {
  private readonly paths: SkillsUsageLedgerPath
  private readonly repoDir: string
  private readonly now: () => Date
  private readonly logger?: ComponentLogger
  private pending = new Map<string, number>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private flushPromise: Promise<void> | undefined

  constructor(options: {
    readonly paths: SkillsUsageLedgerPath
    readonly repoDir: string
    readonly now?: () => Date
    readonly logger?: ComponentLogger
  }) {
    this.paths = options.paths
    this.repoDir = options.repoDir
    this.now = options.now ?? (() => new Date())
    this.logger = options.logger
  }

  /**
   * Records that a skill file was read. If `rawPath` does not resolve to a
   * skill inside the repo, this is a no-op.
   */
  recordRead(rawPath: string): void {
    const skillId = extractSkillId(this.repoDir, rawPath)
    if (skillId === undefined) return
    this.pending.set(skillId, (this.pending.get(skillId) ?? 0) + 1)
    this.scheduleFlush()
  }

  /**
   * Flushes pending increments immediately (used by shutdown drain).
   * Never throws.
   */
  async flush(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) return
    if (this.flushPromise !== undefined) return this.flushPromise
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (this.pending.size === 0) return
    const batch = new Map(this.pending)
    this.pending.clear()
    this.flushPromise = this.flushBatch(batch, signal).finally(() => {
      this.flushPromise = undefined
    })
    return this.flushPromise
  }

  private scheduleFlush(): void {
    if (this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.flush()
    }, DEBOUNCE_MS)
  }

  private async flushBatch(batch: Map<string, number>, signal?: AbortSignal): Promise<void> {
    const isAborted = (): boolean => signal?.aborted === true
    if (isAborted()) return
    const record = await createLockRecord("skills-usage")
    if (isAborted()) return
    try {
      await withLock(
        this.paths.lockPath,
        record,
        async () => {
          const current = await readSkillsUsageLedger(this.paths.ledgerPath)
          const timestamp = this.now().toISOString()
          const updated: Record<string, SkillUsageEntry> = { ...current }
          for (const [skillId, increment] of batch) {
            const entry = updated[skillId]
            updated[skillId] = {
              count: (entry?.count ?? 0) + increment,
              lastUsedAt: timestamp,
            }
          }
          if (isAborted()) return
          await mkdir(join(this.paths.ledgerPath, ".."), { recursive: true })
          if (isAborted()) return
          await writeLedgerAtomic(this.paths.ledgerPath, updated)
        },
        { waitTimeoutMs: LOCK_WAIT_MS },
      )
    } catch (error) {
      this.logger?.warn("skills-usage ledger flush failed", { error: String(error) })
    }
  }
}

/**
 * Options for registering the skills-usage tool_call watcher.
 */
export interface SkillsUsageOptions {
  readonly resolveContext: (eventContext: unknown) => MemoryIdentityContext | undefined
  readonly resolveCwd?: () => string
  readonly logger?: ComponentLogger
  readonly now?: () => Date
}

/**
 * Registers a tool_call handler that watches file-read tools targeting
 * `<memfs repo>/skills/<name>/**` and increments the skills-usage ledger.
 *
 * The write is debounced and serialized under the identity-scoped skills-usage
 * lock. It never blocks or fails the tool.
 */
export function registerSkillsUsage(
  pi: SenpiExtensionAPI,
  options: SkillsUsageOptions,
): Map<string, SkillsUsageTracker> {
  const resolveCwd = options.resolveCwd ?? (() => process.cwd())
  const trackers = new Map<string, SkillsUsageTracker>()

  function trackerFor(context: MemoryIdentityContext): SkillsUsageTracker {
    const existing = trackers.get(context.identity)
    if (existing !== undefined) return existing
    const paths = skillsUsagePaths(context.identityPaths)
    const tracker = new SkillsUsageTracker({
      paths,
      repoDir: context.identityPaths.repo,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    })
    trackers.set(context.identity, tracker)
    return tracker
  }

  pi.on("tool_call", (payload): void => {
    const context = options.resolveContext(payload)
    if (context === undefined) return

    const event = readToolCall(payload)
    if (event === undefined) return
    if (!isReadTool(event.toolName)) return

    for (const rawPath of extractPaths(event.input)) {
      const resolved = resolve(resolveCwd(), rawPath)
      const skillId = extractSkillId(context.identityPaths.repo, resolved)
      if (skillId === undefined) continue
      trackerFor(context).recordRead(resolved)
    }
  })

  return trackers
}

type ToolCall = {
  readonly toolName: string
  readonly input: Record<string, unknown>
}

function readToolCall(value: unknown): ToolCall | undefined {
  if (!isRecord(value)) return undefined
  const toolName = value.toolName
  const input = value.input
  if (typeof toolName !== "string" || !isRecord(input)) return undefined
  return { toolName, input }
}

function isReadTool(toolName: string): boolean {
  const normalized = toolName.trim().toLowerCase().replaceAll("-", "_")
  return READ_TOOL_NAMES.some((name) => normalized === name || normalized.endsWith(`_${name}`) || normalized.endsWith(`:${name}`) || normalized.endsWith(`/${name}`))
}

function extractPaths(input: Record<string, unknown>): string[] {
  const paths: string[] = []
  for (const name of PATH_ARGUMENT_NAMES) {
    const value = input[name]
    if (typeof value === "string" && value.length > 0) paths.push(value)
  }
  const multiple = input.paths
  if (Array.isArray(multiple)) {
    for (const value of multiple) {
      if (typeof value === "string" && value.length > 0) paths.push(value)
    }
  }
  return paths
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
