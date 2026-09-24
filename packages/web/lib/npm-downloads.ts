// OmO shipped under three npm names in sequence, plus the Codex Light edition. None of these
// depends on another, and per-platform binaries are optionalDependencies that are not counted,
// so summing the list counts each install exactly once.
export const NPM_PACKAGES = ["oh-my-opencode", "oh-my-openagent", "omo-ai", "lazycodex-ai"] as const
const NPM_FIRST_PUBLISH_YEAR = 2025

function readDownloads(payload: unknown, context: string): number {
  if (typeof payload !== "object" || payload === null) {
    throw new Error(`npm payload for ${context} is not an object`)
  }
  const downloads = Reflect.get(payload, "downloads")
  if (typeof downloads !== "number" || !Number.isSafeInteger(downloads) || downloads < 0) {
    throw new Error(`npm payload for ${context} has no downloads count`)
  }
  return downloads
}

async function fetchPackageDownloads(
  range: string,
  pkg: string,
  init: RequestInit,
): Promise<number> {
  const url = `https://api.npmjs.org/downloads/point/${range}/${pkg}`
  const response = await fetch(url, init)
  if (!response.ok) {
    throw new Error(`Upstream ${response.status} for ${url}`)
  }
  return readDownloads(await response.json(), `${pkg}@${range}`)
}

/** All-or-nothing: a failed package rejects instead of contributing 0. */
export async function sumLineageDownloads(range: string, init: RequestInit): Promise<number> {
  const counts = await Promise.all(
    NPM_PACKAGES.map((pkg) => fetchPackageDownloads(range, pkg, init)),
  )
  return counts.reduce((sum, n) => sum + n, 0)
}

// npm point ranges are capped at 18 months, so all-time is summed one calendar year at a time.
function yearRanges(now: Date): readonly string[] {
  const today = now.toISOString().slice(0, 10)
  const currentYear = now.getUTCFullYear()
  const ranges: string[] = []
  for (let year = NPM_FIRST_PUBLISH_YEAR; year <= currentYear; year++) {
    const end = year === currentYear ? today : `${year}-12-31`
    ranges.push(`${year}-01-01:${end}`)
  }
  return ranges
}

export async function fetchAllTimeDownloads(now: Date, init: RequestInit): Promise<number> {
  const perYear = await Promise.all(
    yearRanges(now).map((range) => sumLineageDownloads(range, init)),
  )
  return perYear.reduce((sum, n) => sum + n, 0)
}
