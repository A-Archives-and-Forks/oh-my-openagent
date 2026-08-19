export function createBtwParentValidator(dependencies: {
  localExists: (sessionID: string) => boolean
  fetchExists: (sessionID: string) => Promise<boolean>
}) {
  const validatedSessionIDs = new Set<string>()
  const deletedSessionIDs = new Set<string>()

  return {
    exists: async (sessionID: string): Promise<boolean> => {
      if (deletedSessionIDs.has(sessionID)) return false
      if (
        validatedSessionIDs.has(sessionID) ||
        dependencies.localExists(sessionID)
      ) {
        validatedSessionIDs.add(sessionID)
        return true
      }
      const exists = await dependencies.fetchExists(sessionID)
      if (!exists || deletedSessionIDs.has(sessionID)) return false
      validatedSessionIDs.add(sessionID)
      return true
    },
    markDeleted: (sessionID: string): void => {
      validatedSessionIDs.delete(sessionID)
      deletedSessionIDs.add(sessionID)
    },
  }
}
