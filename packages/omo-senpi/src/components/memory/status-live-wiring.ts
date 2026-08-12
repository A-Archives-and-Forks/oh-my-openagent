import { GitMemoryRepo } from "@oh-my-opencode/memory-core"

import type { MemoryIdentityContext } from "./context"
import {
  formatMemoryStatusLine,
  readMemoryStatusSegments,
  type GitRepoForStatus,
} from "./status"
import {
  createMemoryFooterLive,
  type MemoryFooterTimers,
  type MemoryFooterUi,
} from "./status-live"

const SECOND_MS = 1_000
const MINUTE_MS = 60 * SECOND_MS
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

export interface MemoryFooterStatusLiveOptions {
  readonly resolveContext: (sessionId: string) => MemoryIdentityContext | undefined
  readonly isActive: (identity: string) => boolean
  readonly timers?: MemoryFooterTimers
  readonly now?: () => number
  readonly createGitRepo?: (repoPath: string) => GitRepoForStatus
}

export interface MemoryFooterStatusLive {
  /** Starts or stops the spinner for the session's identity, following current run activity. */
  syncActive(sessionId: string | undefined, ui: MemoryFooterUi | undefined): void
  /** Republishes the segment line when the cheap fingerprint moved and no run is animating. */
  refresh(sessionId: string | undefined, ui: MemoryFooterUi | undefined): Promise<void>
  /** Stops animation without retiring the instance (footer clear on session start). */
  stop(): void
  /** Permanently stops animation (session shutdown). */
  dispose(): void
}

/**
 * Binds the generic footer animation to real memory state: it resolves the bound identity for a
 * session, computes the todo-18 segment line, and gates recomputation behind a cheap fingerprint
 * so agent_settled does not shell out to git on every event.
 */
export function createMemoryFooterStatusLive(
  options: MemoryFooterStatusLiveOptions,
): MemoryFooterStatusLive {
  const now = options.now ?? Date.now
  const createRepo = options.createGitRepo ?? defaultGitRepo
  const repos = new Map<string, GitRepoForStatus>()
  let currentSessionId: string | undefined

  function repoFor(context: MemoryIdentityContext): GitRepoForStatus {
    const cached = repos.get(context.identityPaths.repo)
    if (cached !== undefined) return cached
    const repo = createRepo(context.identityPaths.repo)
    repos.set(context.identityPaths.repo, repo)
    return repo
  }

  const live = createMemoryFooterLive({
    ...(options.timers === undefined ? {} : { timers: options.timers }),
    fingerprint: async (identity) => {
      const sessionId = currentSessionId
      const context = sessionId === undefined ? undefined : options.resolveContext(sessionId)
      if (context === undefined || context.identity !== identity) return undefined
      const repo = repoFor(context)
      const head = await repo.head()
      if (head === null) return `none|${options.isActive(identity)}`
      const segments = await readMemoryStatusSegments(repo, context, sessionId)
      return [
        head,
        segments.dirty ? "dirty" : "clean",
        segments.backlogSteps,
        segments.streak,
        options.isActive(identity),
      ].join("|")
    },
    refreshSegments: async (identity) => {
      const sessionId = currentSessionId
      const context = sessionId === undefined ? undefined : options.resolveContext(sessionId)
      if (context === undefined || context.identity !== identity) return undefined
      const repo = repoFor(context)
      const head = await repo.head()
      if (head === null) return undefined
      const committedAt = await repo.headCommitTimestamp()
      const age = committedAt === null ? null : formatRelativeAge(committedAt * SECOND_MS, now())
      if (age === null) return undefined
      const segments = await readMemoryStatusSegments(repo, context, sessionId)
      return formatMemoryStatusLine(identity, age, segments)
    },
  })

  function identityFor(sessionId: string | undefined): string | undefined {
    if (sessionId === undefined) return undefined
    return options.resolveContext(sessionId)?.identity
  }

  return {
    syncActive(sessionId, ui) {
      currentSessionId = sessionId
      const identity = identityFor(sessionId)
      // An unbound session never animates, so no git or filesystem work is scheduled for it.
      if (identity === undefined) return
      live.setActive(identity, options.isActive(identity), ui)
    },

    async refresh(sessionId, ui) {
      currentSessionId = sessionId
      const identity = identityFor(sessionId)
      if (identity === undefined) return
      await live.refresh(identity, ui)
    },

    stop() {
      live.stop()
    },

    dispose() {
      live.dispose()
    },
  }
}

/** Mirrors status.ts's age vocabulary, including its future-timestamp suppression. */
function formatRelativeAge(committedAt: number, current: number): string | null {
  const age = current - committedAt
  if (!Number.isFinite(age) || age < 0) return null
  if (age < MINUTE_MS) return "just now"
  if (age < HOUR_MS) return `${Math.floor(age / MINUTE_MS)}m ago`
  if (age < DAY_MS) return `${Math.floor(age / HOUR_MS)}h ago`
  return `${Math.floor(age / DAY_MS)}d ago`
}

function defaultGitRepo(repoPath: string): GitRepoForStatus {
  const repo = new GitMemoryRepo({ dir: repoPath, agentId: "omo-status" })
  return {
    head: () => repo.head(),
    headCommitTimestamp: () => repo.headCommitTimestamp(),
    lsTree: (revision, path) => repo.lsTree(revision, path),
    show: (revision, path) => repo.show(revision, path),
    status: (paths) => repo.status(paths ?? []),
  }
}
