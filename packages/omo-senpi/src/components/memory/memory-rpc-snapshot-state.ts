import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { GitMemoryRepo, type GitTreeSizedEntry } from "@oh-my-opencode/memory-core"

import type { MemoryIdentityContext } from "./context"
import type {
  MemoryRpcGitRepo,
  MemoryRpcLastOutcome,
  MemoryRpcSnapshot,
} from "./memory-rpc-bridge"
import { MEMORY_HEALTH_SCAN_LIMIT } from "./status"
import { readReflectionHealth } from "./worker/health"

export async function readMemoryRpcRepoState(
  repo: MemoryRpcGitRepo,
  tokenEstimates: Map<string, number>,
): Promise<MemoryRpcSnapshot["repo"]> {
  const [head, dirtyPaths] = await Promise.all([repo.head(), readDirtyPaths(repo)])
  if (head === null) return { dirty: dirtyPaths > 0, dirtyPaths, systemTokensEstimate: 0 }
  const [committedAt, subject, systemTokensEstimate] = await Promise.all([
    repo.headCommitTimestamp().catch(() => null),
    repo.headSubject().catch(() => null),
    estimateSystemTokens(asTreeRepo(repo), head, tokenEstimates),
  ])
  return {
    headSha: head,
    ...(subject === null ? {} : { headSubject: subject }),
    ...(committedAt === null ? {} : { committedAtISO: new Date(committedAt * 1_000).toISOString() }),
    dirty: dirtyPaths > 0,
    dirtyPaths,
    systemTokensEstimate,
  }
}

async function readDirtyPaths(repo: MemoryRpcGitRepo): Promise<number> {
  try {
    return (await repo.status()).split("\n").filter((line) => line.trim().length > 0).length
  } catch {
    return 0
  }
}

export interface MemoryRpcTreeRepo {
  lsTreeSized(revision?: string): Promise<readonly GitTreeSizedEntry[]>
}

export interface MemoryTreeStats {
  readonly totalBytes: number
  readonly fileCount: number
  readonly systemBytes: number
  readonly byTopLevel: Record<string, number>
}

/** Walks `system/*.md` once per commit; a repeat sync on the same HEAD reuses the cached estimate. */
export async function estimateSystemTokens(
  repo: MemoryRpcTreeRepo,
  head: string,
  cache: Map<string, number>,
): Promise<number> {
  const cached = cache.get(head)
  if (cached !== undefined) return cached
  try {
    const totalBytes = (await repo.lsTreeSized(head))
      .filter((entry) => isSystemMarkdown(entry.path))
      .reduce((sum, entry) => sum + entry.bytes, 0)
    const estimate = Math.floor(totalBytes / 4)
    cache.set(head, estimate)
    return estimate
  } catch {
    return 0
  }
}

export function memoryTreeStats(entries: readonly GitTreeSizedEntry[]): MemoryTreeStats {
  const byTopLevel: Record<string, number> = {}
  let totalBytes = 0
  let systemBytes = 0
  for (const entry of entries) {
    totalBytes += entry.bytes
    if (entry.path.startsWith("system/")) systemBytes += entry.bytes
    const slash = entry.path.indexOf("/")
    const topLevel = slash === -1 ? entry.path : entry.path.slice(0, slash)
    byTopLevel[topLevel] = (byTopLevel[topLevel] ?? 0) + entry.bytes
  }
  return { totalBytes, fileCount: entries.length, systemBytes, byTopLevel }
}

function isSystemMarkdown(path: string): boolean {
  return path.startsWith("system/") && path.endsWith(".md")
}

interface JournalState {
  readonly backlogSteps: number
  readonly pendingCompaction: boolean
  readonly totalSteps: number
  readonly reflectedSteps: number
}

export async function readMemoryRpcJournalState(
  context: MemoryIdentityContext,
  sessionId: string,
): Promise<JournalState> {
  const empty: JournalState = {
    backlogSteps: 0,
    pendingCompaction: context.ledger.pendingCompaction,
    totalSteps: 0,
    reflectedSteps: 0,
  }
  try {
    const raw: unknown = JSON.parse(
      await readFile(join(context.identityPaths.transcripts, sessionId, "state.json"), "utf8"),
    )
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return empty
    const state = raw as Record<string, unknown>
    return {
      backlogSteps: countOf(state.steps_since_last_successful_reflection),
      pendingCompaction: state.pending_compaction === true || context.ledger.pendingCompaction,
      totalSteps: countOf(state.total_completed_steps),
      reflectedSteps: countOf(state.reflected_completed_steps),
    }
  } catch {
    return empty
  }
}

function countOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

interface HealthState {
  readonly streak: number
  readonly fingerprint?: string
  readonly lastOutcome?: MemoryRpcLastOutcome
}

export async function readMemoryRpcHealth(context: MemoryIdentityContext): Promise<HealthState> {
  try {
    const health = await readReflectionHealth(
      join(context.identityPaths.reflection, "completions"),
      { limit: MEMORY_HEALTH_SCAN_LIMIT },
    )
    const last = health.lastOutcome
    return {
      streak: health.streak,
      ...(health.fingerprint.length === 0 ? {} : { fingerprint: health.fingerprint }),
      ...(last === undefined
        ? {}
        : {
            lastOutcome: {
              runId: last.runId,
              outcome: last.outcome,
              ...(last.reason === undefined ? {} : { reason: last.reason }),
              finishedAt: last.finishedAt,
            },
          }),
    }
  } catch {
    return { streak: 0 }
  }
}

export function createMemoryRpcGitRepo(repoPath: string): MemoryRpcGitRepo & MemoryRpcTreeRepo {
  const repo = new GitMemoryRepo({ dir: repoPath, agentId: "omo-memory-rpc" })
  return {
    head: () => repo.head(),
    headCommitTimestamp: () => repo.headCommitTimestamp(),
    headSubject: async () => (await repo.log({ limit: 1 }))[0]?.subject ?? null,
    status: (paths) => repo.status(paths ?? []),
    lsTree: (revision, path) => repo.lsTree(revision, path),
    lsTreeSized: (revision) => repo.lsTreeSized(revision),
    show: (revision, path) => repo.show(revision, path),
  }
}

function asTreeRepo(repo: MemoryRpcGitRepo): MemoryRpcTreeRepo {
  const lsTreeSized = (repo as Partial<MemoryRpcTreeRepo>).lsTreeSized
  if (typeof lsTreeSized !== "function") {
    return {
      lsTreeSized: async () => {
        throw new Error("lsTreeSized unavailable")
      },
    }
  }
  return { lsTreeSized: (revision) => lsTreeSized.call(repo, revision) }
}
