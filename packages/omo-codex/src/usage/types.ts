export type CodexUsageWindow = {
  readonly usedPercent: number
  readonly remainingPercent: number
  readonly windowDurationMins: number
  readonly resetsAt: string
}

export type CodexUsageCredits = {
  readonly hasCredits: boolean
  readonly unlimited: boolean
  readonly balance: string
}

export type CodexUsageLimit = {
  readonly id: string
  readonly label: string
  readonly planType: string | null
  readonly primary: CodexUsageWindow | null
  readonly secondary: CodexUsageWindow | null
  readonly credits: CodexUsageCredits | null
  readonly rateLimitReachedType: string | null
}

export type CodexUsageReport = {
  readonly fetchedAt: string
  readonly authType: string | null
  readonly planType: string | null
  readonly limits: readonly CodexUsageLimit[]
  readonly resetCredits: {
    readonly availableCount: number
  } | null
}
