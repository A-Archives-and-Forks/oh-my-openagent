import type { CodexUsageCredits, CodexUsageReport, CodexUsageWindow } from "./types"

export function formatCodexUsage(report: CodexUsageReport): string {
  const lines = [
    "OpenAI Codex Usage",
    `Plan: ${displayName(report.planType)}`,
    `Authentication: ${displayName(report.authType)}`,
  ]

  for (const limit of report.limits) {
    lines.push("", limit.label)
    appendWindow(lines, limit.primary)
    appendWindow(lines, limit.secondary)
    if (limit.credits !== null) {
      lines.push(`  Credits: ${formatCredits(limit.credits)}`)
    }
  }

  const reachedTypes = report.limits
    .map((limit) => limit.rateLimitReachedType)
    .filter((value): value is string => value !== null)
  lines.push(
    "",
    `Saved resets: ${report.resetCredits?.availableCount ?? "unavailable"}`,
    reachedTypes.length === 0 ? "Status: available" : `Status: limited (${[...new Set(reachedTypes)].join(", ")})`,
  )
  return lines.join("\n")
}

export function formatCodexUsageJson(report: CodexUsageReport): string {
  return JSON.stringify(report, null, 2)
}

function appendWindow(lines: string[], window: CodexUsageWindow | null): void {
  if (window === null) return
  lines.push(
    `  ${formatDuration(window.windowDurationMins)}: ${formatPercent(window.usedPercent)} used, ${formatPercent(window.remainingPercent)} remaining`,
    `  Resets: ${window.resetsAt}`,
  )
}

function formatDuration(minutes: number): string {
  if (minutes % 1440 === 0) return plural(minutes / 1440, "day")
  if (minutes % 60 === 0) return plural(minutes / 60, "hour")
  return plural(minutes, "minute")
}

function plural(value: number, unit: string): string {
  return `${value} ${unit}${value === 1 ? "" : "s"}`
}

function formatPercent(value: number): string {
  return `${Number.isInteger(value) ? value : value.toFixed(1)}%`
}

function formatCredits(credits: CodexUsageCredits): string {
  if (credits.unlimited) return "unlimited"
  if (!credits.hasCredits) return "none"
  return credits.balance
}

function displayName(value: string | null): string {
  if (value === null) return "Unknown"
  if (value.toLowerCase() === "chatgpt") return "ChatGPT"
  return value.charAt(0).toUpperCase() + value.slice(1)
}
