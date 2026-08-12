/**
 * Tracks which reflection runs are in flight per identity so the footer knows when to animate.
 * Runs are counted by id, not by a boolean, because a settle of one run must not cancel the
 * spinner while a second run for the same identity is still working.
 */
export interface ActiveReflectionRuns {
  start(identity: string, runId: string): void
  settle(identity: string, runId: string): void
  clear(identity: string): void
  isActive(identity: string): boolean
}

export function createActiveReflectionRuns(): ActiveReflectionRuns {
  const byIdentity = new Map<string, Set<string>>()

  return {
    start(identity, runId) {
      const runs = byIdentity.get(identity) ?? new Set<string>()
      runs.add(runId)
      byIdentity.set(identity, runs)
    },

    settle(identity, runId) {
      const runs = byIdentity.get(identity)
      if (runs === undefined) return
      runs.delete(runId)
      if (runs.size === 0) byIdentity.delete(identity)
    },

    clear(identity) {
      byIdentity.delete(identity)
    },

    isActive(identity) {
      return (byIdentity.get(identity)?.size ?? 0) > 0
    },
  }
}
