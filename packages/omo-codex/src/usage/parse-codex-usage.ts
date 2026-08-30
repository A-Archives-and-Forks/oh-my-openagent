import type {
  CodexUsageCredits,
  CodexUsageLimit,
  CodexUsageReport,
  CodexUsageWindow,
} from "./types"

const LIMIT_LABELS: Readonly<Record<string, string>> = {
  codex: "Codex",
  codex_bengalfox: "Spark",
}

export function parseCodexUsageResponses(
  accountResponse: unknown,
  rateLimitsResponse: unknown,
  fetchedAt = new Date(),
): CodexUsageReport {
  const account = nestedRecord(accountResponse, "account")
  const response = asRecord(rateLimitsResponse)
  const current = nestedRecord(response, "rateLimits")
  const currentId = stringValue(current?.limitId) ?? "codex"
  const limitsById = nestedRecord(response, "rateLimitsByLimitId")
  const parsedById = new Map<string, CodexUsageLimit>()

  if (limitsById !== null) {
    for (const [id, value] of Object.entries(limitsById)) {
      const parsed = parseUsageLimit(id, value)
      if (parsed !== null) parsedById.set(id, parsed)
    }
  }

  if (!parsedById.has(currentId)) {
    const parsedCurrent = parseUsageLimit(currentId, current)
    if (parsedCurrent !== null) parsedById.set(currentId, parsedCurrent)
  }

  const limits = [...parsedById.values()].sort(compareLimits)
  if (limits.length === 0) {
    throw new Error("Codex app-server returned no valid usage limits")
  }

  const primaryLimit = limits.find((limit) => limit.id === currentId) ?? limits[0]
  const accountPlanType = stringValue(account?.planType)
  const resetCredits = nestedRecord(response, "rateLimitResetCredits")
  const availableCount = numberValue(resetCredits?.availableCount)

  return {
    fetchedAt: fetchedAt.toISOString(),
    authType: stringValue(account?.type),
    planType: primaryLimit?.planType ?? accountPlanType,
    limits,
    resetCredits:
      availableCount === null
        ? null
        : {
            availableCount: Math.max(0, Math.trunc(availableCount)),
          },
  }
}

function parseUsageLimit(id: string, value: unknown): CodexUsageLimit | null {
  const limit = asRecord(value)
  if (limit === null) return null
  const primary = parseUsageWindow(limit.primary)
  const secondary = parseUsageWindow(limit.secondary)
  if (primary === null && secondary === null) return null

  return {
    id,
    label: stringValue(limit.limitName) ?? LIMIT_LABELS[id] ?? id,
    planType: stringValue(limit.planType),
    primary,
    secondary,
    credits: parseCredits(limit.credits),
    rateLimitReachedType: stringValue(limit.rateLimitReachedType),
  }
}

function parseUsageWindow(value: unknown): CodexUsageWindow | null {
  const window = asRecord(value)
  if (window === null) return null
  const usedPercent = numberValue(window.usedPercent)
  const windowDurationMins = numberValue(window.windowDurationMins)
  const resetsAt = numberValue(window.resetsAt)
  if (usedPercent === null || windowDurationMins === null || resetsAt === null) return null

  return {
    usedPercent,
    remainingPercent: Math.max(0, Math.min(100, 100 - usedPercent)),
    windowDurationMins,
    resetsAt: new Date(resetsAt * 1000).toISOString(),
  }
}

function parseCredits(value: unknown): CodexUsageCredits | null {
  const credits = asRecord(value)
  if (credits === null || typeof credits.hasCredits !== "boolean" || typeof credits.unlimited !== "boolean") {
    return null
  }
  const balance = credits.balance
  if (typeof balance !== "string" && typeof balance !== "number") return null
  return {
    hasCredits: credits.hasCredits,
    unlimited: credits.unlimited,
    balance: String(balance),
  }
}

function compareLimits(left: CodexUsageLimit, right: CodexUsageLimit): number {
  if (left.id === "codex") return right.id === "codex" ? 0 : -1
  if (right.id === "codex") return 1
  return left.id.localeCompare(right.id)
}

function nestedRecord(value: unknown, key: string): Record<string, unknown> | null {
  return asRecord(asRecord(value)?.[key])
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}
