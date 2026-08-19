import type { BtwSideMetadata } from "./metadata"

type CachedAdoption =
  | { hydrated: false }
  | { hydrated: true; metadata?: BtwSideMetadata }

export function createBtwAdoptionCache() {
  const entries = new Map<string, BtwSideMetadata | null>()

  return {
    read: (sessionID: string): CachedAdoption => {
      if (!entries.has(sessionID)) return { hydrated: false }
      return {
        hydrated: true,
        metadata: entries.get(sessionID) ?? undefined,
      }
    },
    write: (
      sessionID: string,
      metadata: BtwSideMetadata | undefined,
    ): void => {
      entries.set(sessionID, metadata ?? null)
    },
    removeForDeletion: (sessionID: string): void => {
      entries.delete(sessionID)
      for (const [sideSessionID, metadata] of entries) {
        if (metadata?.parent_session_id === sessionID) {
          entries.delete(sideSessionID)
        }
      }
    },
  }
}
