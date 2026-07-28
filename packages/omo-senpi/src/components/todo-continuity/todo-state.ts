export const TODO_STATE_ENTRY_TYPE = "senpi.todo-state"

export interface TodoStateSummary {
  open: number
  total: number
  next: string | undefined
}

interface ParsedTask {
  content: string
  status: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function sanitizeTaskText(text: string): string {
  return text
    .replace(/[\r\n]+/g, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function parseTask(value: unknown, lenient: boolean): ParsedTask | undefined {
  if (!isRecord(value) || typeof value["content"] !== "string") return undefined
  const status = value["status"]
  if (typeof status === "string") return { content: value["content"], status }
  return lenient ? { content: value["content"], status: "pending" } : undefined
}

function parseTasks(value: unknown, lenient: boolean): ParsedTask[] | undefined {
  if (!Array.isArray(value)) return undefined
  const tasks: ParsedTask[] = []
  for (const candidate of value) {
    const task = parseTask(candidate, lenient)
    if (!task) return undefined
    tasks.push(task)
  }
  return tasks
}

function parsePhases(value: unknown): ParsedTask[] | undefined {
  if (!Array.isArray(value)) return undefined
  const tasks: ParsedTask[] = []
  for (const candidate of value) {
    if (!isRecord(candidate) || typeof candidate["name"] !== "string") return undefined
    const phaseTasks = parseTasks(candidate["tasks"], false)
    if (!phaseTasks) return undefined
    tasks.push(...phaseTasks)
  }
  return tasks
}

function readTodoPayload(value: unknown): ParsedTask[] | undefined {
  if (!isRecord(value)) return undefined
  if (value["schema"] === "v2") return parsePhases(value["phases"])
  if (Array.isArray(value["phases"])) return parsePhases(value["phases"])
  if (Array.isArray(value["todos"])) return parseTasks(value["todos"], true)
  return undefined
}

function payloadFromEntry(entry: unknown): unknown {
  if (!isRecord(entry)) return undefined
  if (entry["type"] === "custom" && entry["customType"] === TODO_STATE_ENTRY_TYPE) {
    return entry["data"]
  }
  if (entry["type"] !== "message" || !isRecord(entry["message"])) return undefined
  const message = entry["message"]
  if (message["role"] !== "toolResult") return undefined
  if (message["toolName"] !== "todo" && message["toolName"] !== "todowrite") return undefined
  return message["details"]
}

function isTerminalStatus(status: string): boolean {
  return status === "completed" || status === "abandoned" || status === "cancelled"
}

export function summarizeLatestTodoState(entries: readonly unknown[]): TodoStateSummary | undefined {
  let latest: ParsedTask[] | undefined
  for (const entry of entries) {
    const parsed = readTodoPayload(payloadFromEntry(entry))
    if (parsed) latest = parsed
  }
  if (!latest) return undefined

  const openTasks = latest.filter((task) => !isTerminalStatus(task.status))
  const inProgress = openTasks.find((task) => task.status === "in_progress")
  const next = inProgress ?? openTasks[0]
  return {
    open: openTasks.length,
    total: latest.length,
    next: next ? sanitizeTaskText(next.content) : undefined,
  }
}
