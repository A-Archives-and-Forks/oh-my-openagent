// Recall message renderer: builds the late-hidden recall block injected as a
// hint message. The shape is a fixed contract consumed by the harness-side
// recall wiring; empty candidates render to an empty string so callers inject
// nothing.

import type { RecallCandidate } from "./select"

const HEADER_LINE =
  "A stored memory surfaced. It is a hint, not current state — verify before relying on it; read the source path for full context."

export function renderRecallMessage(candidates: readonly RecallCandidate[]): string {
  if (candidates.length === 0) return ""
  const bullets = candidates.map(
    (candidate) => `- [[${candidate.path}]] — ${candidate.description} · "${candidate.excerpt}"`,
  )
  return ["<recalled-memory>", HEADER_LINE, ...bullets, "</recalled-memory>"].join("\n")
}
