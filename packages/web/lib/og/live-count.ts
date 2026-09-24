export type OgCount =
  | { readonly count: number; readonly source: "live"; readonly expiresAt: number }
  | { readonly count: number; readonly source: "stale" }
  | { readonly count: null; readonly source: "unavailable" }

export interface OgCountSource {
  readonly get: () => Promise<OgCount>
  readonly reset: () => void
}

/**
 * A bounded, coalesced cache for one live social-image figure. Failures are never cached:
 * the last known good value is served for at most `maxStaleMs`, then the figure is withheld.
 */
export function createOgCountSource(options: {
  readonly label: string
  readonly freshMs: number
  readonly maxStaleMs: number
  readonly load: () => Promise<number>
}): OgCountSource {
  let cache: { readonly count: number; readonly timestamp: number } | null = null
  let pending: Promise<OgCount> | null = null

  async function refresh(): Promise<OgCount> {
    try {
      const count = await options.load()
      cache = { count, timestamp: Date.now() }
      return { count, source: "live", expiresAt: cache.timestamp + options.freshMs }
    } catch (error) {
      console.warn(`Unable to refresh OG ${options.label}`, error)
      if (cache && Date.now() - cache.timestamp <= options.maxStaleMs) {
        return { count: cache.count, source: "stale" }
      }
      return { count: null, source: "unavailable" }
    }
  }

  return {
    async get() {
      if (cache && Date.now() - cache.timestamp < options.freshMs) {
        return { count: cache.count, source: "live", expiresAt: cache.timestamp + options.freshMs }
      }
      if (pending) return pending
      pending = refresh()
      try {
        return await pending
      } finally {
        pending = null
      }
    },
    reset() {
      cache = null
      pending = null
    },
  }
}
