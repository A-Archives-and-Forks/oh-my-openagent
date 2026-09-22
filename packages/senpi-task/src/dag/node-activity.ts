import * as fs from "node:fs"

import { taskEventLogPath } from "../store/event-log"

/**
 * Dates a running node's child by its transcript log: the manager appends one line per assistant
 * message and per tool call, so the file's mtime is the last moment the child actually did
 * something. TaskRecord.updated_at cannot answer this - it only moves on status and residency
 * transitions, so a child that has been silent for an hour still reads as freshly updated (#8674).
 */
export function readDagNodeActivityAt(stateDir: string, taskId: string): string | undefined {
  const stats = fs.statSync(taskEventLogPath(stateDir, taskId), { throwIfNoEntry: false })
  return stats === undefined ? undefined : new Date(stats.mtimeMs).toISOString()
}
