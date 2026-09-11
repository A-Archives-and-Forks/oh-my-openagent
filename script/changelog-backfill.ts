#!/usr/bin/env bun

/**
 * OmO Changelog Backfill Transformer
 *
 * Pure, deterministic functions for transforming release bodies into changelog entries.
 * All inputs and outputs are immutable; stamping and extraction are idempotent.
 * No live GitHub fetch; all data flows through fixtures.
 */

/**
 * Immutable release representation from git tag metadata.
 */
export interface Release {
  tagName: string
  publishedAt: string | null // ISO 8601 UTC; null indicates missing/unpublished
  body: string | null
  isPrerelease: boolean
}

/**
 * Normalized changelog entry ready for insertion.
 */
export interface ChangelogEntry {
  version: string // e.g. "5.0.0-beta.3"
  date: string // ISO 8601 date only, e.g. "2026-08-10"
  content: string // normalized release body
  marked: boolean // true if backfill marker was present
  publishedAt: string // full ISO 8601 timestamp
}

/**
 * Validation error detail.
 */
export interface ValidationError {
  code: string
  message: string
  field: string
}

// Backfill marker pattern: HTML comment with version anchor
const BACKFILL_MARKER_PATTERN = /<!-- omo-backfill-marker: ([\w.-]+) -->/
const BACKFILL_MARKER_TEMPLATE = "<!-- omo-backfill-marker: {VERSION} -->"

/**
 * Deterministic heading normalization.
 *
 * Rules:
 * - Trim leading/trailing whitespace
 * - Preserve internal structure (## Fixed, ### Added, etc.)
 * - Normalize consecutive blank lines to single line
 * - Strip trailing whitespace per line
 *
 * Same input always produces same output (pure function, no randomness).
 */
export function normalizeHeading(heading: string): string {
  if (!heading || typeof heading !== "string") return ""

  const lines = heading.split("\n").map((line) => line.trimEnd())
  const normalized: string[] = []
  let lastBlank = false

  for (const line of lines) {
    const isBlank = line.trim() === ""
    if (isBlank && lastBlank) continue // Skip consecutive blank lines
    normalized.push(line)
    lastBlank = isBlank
  }

  return normalized.join("\n").trim()
}

/**
 * Stamp a release body with the backfill marker (version anchor).
 *
 * Idempotent: if the marker already exists with the same version, returns unchanged.
 * Otherwise, appends the marker at the end.
 *
 * @param body Release body text
 * @param version Version string (e.g. "5.0.0-beta.3")
 * @returns Body with marker stamped (or already present)
 */
export function stampBackfillMarker(body: string, version: string): string {
  if (!body || typeof body !== "string") return ""
  if (!version || typeof version !== "string") return body

  const match = body.match(BACKFILL_MARKER_PATTERN)
  if (match && match[1] === version) {
    // Already stamped with this version
    return body
  }

  // Append marker at end, with blank line separator if needed
  const trimmed = body.trimEnd()
  const marker = BACKFILL_MARKER_TEMPLATE.replace("{VERSION}", version)
  return `${trimmed}\n\n${marker}`
}

/**
 * Extract the backfill marker from a release body.
 *
 * @param body Release body text
 * @returns { marked: true/false, version: extracted version or null }
 */
export function extractBackfillMarker(body: string): { marked: boolean; version: string | null } {
  if (!body || typeof body !== "string") return { marked: false, version: null }

  const match = body.match(BACKFILL_MARKER_PATTERN)
  if (!match) return { marked: false, version: null }

  return { marked: true, version: match[1] ?? null }
}

/**
 * Parse version from tag name (e.g. "v5.0.0-beta.3" -> "5.0.0-beta.3").
 *
 * @param tagName Git tag (e.g. "v5.0.0-beta.3")
 * @returns Version string without leading 'v'
 */
export function parseVersion(tagName: string): string {
  if (!tagName || typeof tagName !== "string") return ""
  return tagName.replace(/^v/, "")
}

/**
 * Parse date from ISO 8601 timestamp to date-only string.
 *
 * @param timestamp ISO 8601 timestamp (e.g. "2026-08-10T10:16:58Z")
 * @returns Date string (e.g. "2026-08-10")
 */
export function parseDate(timestamp: string): string {
  if (!timestamp || typeof timestamp !== "string") return ""
  // Simple split to avoid timezone pitfalls; input must be UTC
  return timestamp.split("T")[0] ?? ""
}

/**
 * Validate a release for backfill eligibility.
 *
 * Fail-closed validation: a release with ANY error is rejected.
 *
 * Checks:
 * - publishedAt must be a valid UTC ISO 8601 timestamp (not null)
 * - body must be non-empty string
 * - backfill marker must be present
 * - version must parse cleanly from tagName
 *
 * @param release Release to validate
 * @returns Array of validation errors (empty = valid)
 */
export function validateReleaseRequirements(release: Release): ValidationError[] {
  const errors: ValidationError[] = []

  // Check tagName exists and parses
  if (!release.tagName || typeof release.tagName !== "string") {
    errors.push({
      code: "INVALID_TAG_NAME",
      message: "tagName must be a non-empty string",
      field: "tagName",
    })
  } else {
    const version = parseVersion(release.tagName)
    if (!version) {
      errors.push({
        code: "INVALID_VERSION_PARSE",
        message: `Failed to parse version from tag: ${release.tagName}`,
        field: "tagName",
      })
    }
  }

  // Check publishedAt is UTC ISO 8601 (not null)
  if (!release.publishedAt || typeof release.publishedAt !== "string") {
    errors.push({
      code: "MISSING_PUBLISHED_AT",
      message: "publishedAt must be a non-empty UTC ISO 8601 timestamp",
      field: "publishedAt",
    })
  } else {
    // Validate UTC ISO 8601 pattern (basic check)
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(release.publishedAt)) {
      errors.push({
        code: "INVALID_TIMESTAMP_FORMAT",
        message: `publishedAt must be UTC ISO 8601 (e.g. 2026-08-10T10:16:58Z), got: ${release.publishedAt}`,
        field: "publishedAt",
      })
    }
  }

  // Check body exists
  if (!release.body || typeof release.body !== "string") {
    errors.push({
      code: "MISSING_BODY",
      message: "body must be a non-empty string",
      field: "body",
    })
  } else {
    // Check backfill marker present
    const { marked } = extractBackfillMarker(release.body)
    if (!marked) {
      errors.push({
        code: "MISSING_BACKFILL_MARKER",
        message: "body must contain backfill marker (<!-- omo-backfill-marker: version -->)",
        field: "body",
      })
    }
  }

  return errors
}

/**
 * Transform a validated release into a changelog entry.
 *
 * Pure function: same input always produces same output.
 * Returns null if validation fails (fail-closed).
 *
 * @param release Release to transform
 * @returns ChangelogEntry or null if validation fails
 */
export function transformReleaseToEntry(release: Release): ChangelogEntry | null {
  const errors = validateReleaseRequirements(release)
  if (errors.length > 0) {
    return null // Fail-closed: validation error means no entry
  }

  const version = parseVersion(release.tagName)
  const date = parseDate(release.publishedAt!)
  const { marked } = extractBackfillMarker(release.body!)
  const content = normalizeHeading(release.body!)

  return {
    version,
    date,
    content,
    marked,
    publishedAt: release.publishedAt!,
  }
}

/**
 * Batch transform releases into changelog entries.
 *
 * Silently skips releases that fail validation (fail-closed).
 * Preserves order of input releases.
 *
 * @param releases Array of releases
 * @returns Array of successfully transformed entries
 */
export function transformReleases(releases: Release[]): ChangelogEntry[] {
  if (!Array.isArray(releases)) return []

  return releases.flatMap((release) => {
    const entry = transformReleaseToEntry(release)
    return entry ? [entry] : []
  })
}

/**
 * Audit a fixture for missing releases.
 *
 * @param fixture Array of releases from fixture
 * @returns { missingCount: number; missingTags: string[] }
 */
export function auditFixtureMissingReleases(fixture: Release[]): {
  missingCount: number
  missingTags: string[]
} {
  const missing = fixture.filter((r) => r.publishedAt === null || r.body === null)
  return {
    missingCount: missing.length,
    missingTags: missing.map((r) => r.tagName),
  }
}
