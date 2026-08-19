export function createBtwAdoptionGuard(
  currentSessionID: () => string | undefined,
) {
  const deletedSessionIDs = new Set<string>()
  let disposed = false

  return {
    canApply: (sessionID: string): boolean =>
      !disposed &&
      !deletedSessionIDs.has(sessionID) &&
      currentSessionID() === sessionID,
    markDeleted: (sessionID: string): void => {
      deletedSessionIDs.add(sessionID)
    },
    dispose: (): void => {
      disposed = true
    },
  }
}
