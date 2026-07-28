import type { ComponentContext, OmoSenpiComponent, SenpiExtensionAPI } from "../../extension/types"
import { summarizeLatestTodoState, type TodoStateSummary } from "./todo-state"

export const TODO_CONTINUITY_DISABLED_FLAG = "omo-senpi-todo-continuity-disabled"
export const TODO_CONTINUITY_REMINDER_TYPE = "omo-todo-continuity:reminder"

const TAG_OPEN = "<omo-todo-continuity>"
const TAG_CLOSE = "</omo-todo-continuity>"

type InputResult =
  | { action: "continue" }
  | { action: "transform"; text: string; images?: readonly unknown[] }

export function createTodoContinuityComponent(): OmoSenpiComponent {
  return {
    name: "todo-continuity",
    register(pi: SenpiExtensionAPI, ctx: ComponentContext): void {
      pi.on("input", (payload: unknown, eventCtx: unknown): InputResult => {
        if (ctx.config.getFlag(TODO_CONTINUITY_DISABLED_FLAG) === true) return { action: "continue" }
        if (!isUserInput(payload) || hasContinuityTags(payload.text)) return { action: "continue" }

        const entries = readBranchEntries(eventCtx, ctx)
        if (!entries) return { action: "continue" }
        const summary = summarizeLatestTodoState(entries)
        if (!summary || summary.open === 0) return { action: "continue" }

        const reminder = buildTodoContinuityReminder(summary)
        if (isQueuedInput(payload)) {
          const images = payload["images"]
          return {
            action: "transform",
            text: `${payload.text}\n${reminder}`,
            ...(Array.isArray(images) ? { images } : {}),
          }
        }

        pi.sendMessage({
          customType: TODO_CONTINUITY_REMINDER_TYPE,
          content: reminder,
          display: false,
        })
        return { action: "continue" }
      })
    },
  }
}

function buildTodoContinuityReminder(summary: TodoStateSummary): string {
  const next = summary.next ? ` Next: ${summary.next}.` : ""
  return [
    TAG_OPEN,
    `${summary.open}/${summary.total} todo items remain open.${next}`,
    "Run `todo view` before acting. Reconcile this message with every open commitment: keep non-conflicting work, amend contradictions, append additions, and replace only on explicit redirect.",
    "Then continue the earliest valid task and refresh the todo immediately after each completion.",
    TAG_CLOSE,
  ].join("\n")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isUserInput(payload: unknown): payload is Record<string, unknown> & { text: string } {
  return (
    isRecord(payload) &&
    payload["type"] === "input" &&
    payload["source"] !== "extension" &&
    typeof payload["text"] === "string"
  )
}

function hasContinuityTags(text: string): boolean {
  return text.includes(TAG_OPEN) && text.includes(TAG_CLOSE)
}

function isQueuedInput(payload: Record<string, unknown>): boolean {
  return payload["streamingBehavior"] !== undefined
}

function readBranchEntries(eventCtx: unknown, ctx: ComponentContext): readonly unknown[] | undefined {
  if (!isRecord(eventCtx) || !isRecord(eventCtx["sessionManager"])) return undefined
  const sessionManager = eventCtx["sessionManager"]
  const getBranch = sessionManager["getBranch"]
  if (typeof getBranch !== "function") return undefined
  try {
    const entries: unknown = getBranch.call(sessionManager)
    return Array.isArray(entries) ? entries : undefined
  } catch (error) {
    ctx.logger.warn("omo-senpi todo-continuity branch read failed", {
      error: error instanceof Error ? error.message : String(error),
    })
    return undefined
  }
}
