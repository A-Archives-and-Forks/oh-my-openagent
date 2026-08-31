import { TASK_CLEANUP_DELAY_MS } from "../../features/background-agent/constants"
import { handedBackSyncSessions } from "../../features/claude-code-session-state"
import { log } from "../../shared/logger"
import type { OpencodeClient } from "./types"

export function scheduleSyncSessionDeletion(
  client: OpencodeClient,
  sessionID: string,
  delayMs = TASK_CLEANUP_DELAY_MS,
): void {
  const deleteSession = client?.session?.delete
  if (typeof deleteSession !== "function") return
  const timer = setTimeout(() => {
    try {
      void deleteSession({ path: { id: sessionID } }).then(() => {
      handedBackSyncSessions.delete(sessionID)
      }).catch((error: unknown) => {
        log("[task] Failed to delete completed sync session:", { sessionID, error: String(error) })
      })
    } catch (error) {
      log("[task] Failed to schedule completed sync session deletion:", { sessionID, error: String(error) })
    }
  }, delayMs)
  timer.unref()
}
