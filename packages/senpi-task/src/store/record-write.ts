import { mkdirSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

import { parseTaskId } from "../state"
import type { TaskId, TaskRecord } from "../state"

export type WriteRecordMode = "create" | "replace"

export class TaskRecordCollisionError extends Error {
  readonly taskId: TaskId
  readonly path: string

  constructor(input: { readonly taskId: TaskId; readonly path: string }) {
    super(`Task record already exists: ${input.taskId}`)
    this.name = "TaskRecordCollisionError"
    this.taskId = input.taskId
    this.path = input.path
  }
}

export function writeRecord(path: string, record: TaskRecord, mode: WriteRecordMode): void {
  mkdirSync(dirname(path), { recursive: true })
  const payload = JSON.stringify(record)
  if (mode === "create") {
    try {
      writeFileSync(path, payload, { encoding: "utf8", flag: "wx" })
      return
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        throw new TaskRecordCollisionError({ taskId: parseTaskId(record.task_id), path })
      }
      throw error
    }
  }

  const tmpPath = `${path}.${process.pid}.tmp`
  writeFileSync(tmpPath, payload, "utf8")
  renameSync(tmpPath, path)
}
