import { TASK_CLEANUP_DELAY_MS } from "../../features/background-agent/constants"
import { handedBackSyncSessions } from "../../features/claude-code-session-state"
import { log } from "../../shared/logger"
import type { OpencodeClient } from "./types"

export function scheduleSyncSessionDeletion(
  client: OpencodeClient,
  sessionID: string,
  delayMs = TASK_CLEANUP_DELAY_MS,
): void {
  if (typeof client.session.delete !== "function") return
  const timer = setTimeout(() => {
    void client.session.delete({ path: { id: sessionID } }).then(() => {
      handedBackSyncSessions.delete(sessionID)
    }).catch((error: unknown) => {
      log("[task] Failed to delete completed sync session:", { sessionID, error: String(error) })
    })
  }, delayMs)
  timer.unref()
}
