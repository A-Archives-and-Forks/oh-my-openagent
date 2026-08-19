import { getBtwSideMetadata } from "./metadata"

const verifiedSideSessionIDs = new Set<string>()
const provisionallyRestrictedSessionIDs = new Set<string>()

export function trackBtwSideSession(session: {
  id: string
  metadata?: Record<string, unknown>
}): boolean {
  if (!getBtwSideMetadata(session)) return false
  markBtwSideSession(session.id)
  return true
}

export function markBtwSideSession(sessionID: string): void {
  provisionallyRestrictedSessionIDs.delete(sessionID)
  verifiedSideSessionIDs.add(sessionID)
}

export function markBtwSessionProvisionallyRestricted(
  sessionID: string,
): void {
  if (!verifiedSideSessionIDs.has(sessionID)) {
    provisionallyRestrictedSessionIDs.add(sessionID)
  }
}

export function clearBtwProvisionalRestriction(sessionID: string): void {
  provisionallyRestrictedSessionIDs.delete(sessionID)
}

export function forgetBtwSideSession(sessionID: string): boolean {
  const verified = verifiedSideSessionIDs.delete(sessionID)
  const provisional = provisionallyRestrictedSessionIDs.delete(sessionID)
  return verified || provisional
}

export function isTrackedBtwSideSession(sessionID: string): boolean {
  return (
    verifiedSideSessionIDs.has(sessionID) ||
    provisionallyRestrictedSessionIDs.has(sessionID)
  )
}

export function resetBtwSideSessionRegistryForTesting(): void {
  verifiedSideSessionIDs.clear()
  provisionallyRestrictedSessionIDs.clear()
}

