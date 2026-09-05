import type { ChildHandle, CreateChildSession, InProcessRunnerLike } from "@oh-my-opencode/senpi-task"

import type { ComponentLogger } from "../../extension/types"
import { abortAndDispose } from "./memorian-lifecycle"

const DEFAULT_DEADLINE_MS = 5 * 60_000

type TaskRuntime = typeof import("#omo-task-runtime")
export type StartChildInput = Parameters<InProcessRunnerLike["start"]>[0]
export type InProcessMemoryChildState = { cancelled: boolean; cancel?: () => void }

export type MemoryChildResult =
  | { readonly status: "completed" }
  | { readonly status: "failed"; readonly cause: "session_create_failed" | "deadline" | "cancelled" | "child_failed" }

export interface RunInProcessMemoryChildInput {
  readonly runId: string
  readonly deadlineMs?: number
  readonly state: InProcessMemoryChildState
  readonly logger?: ComponentLogger
  readonly createRunner?: (options: { readonly createSession?: CreateChildSession }) => InProcessRunnerLike
  readonly createSession?: CreateChildSession
  readonly setup: () => Promise<void>
  readonly buildStart: (taskRuntime: TaskRuntime) => StartChildInput
  readonly onHandle?: (handle: ChildHandle) => void
  readonly onState?: (state: InProcessMemoryChildState) => void
  readonly onSetupSettled?: () => void
}

export async function runInProcessMemoryChild(input: RunInProcessMemoryChildInput): Promise<MemoryChildResult> {
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined
  let deadlineReached = false
  let resolveCancelled: (() => void) | undefined
  const cancelled = new Promise<void>((resolve) => { resolveCancelled = resolve })
  input.onState?.(input.state)
  input.state.cancel = () => {
    input.state.cancelled = true
    resolveCancelled?.()
  }
  const deadline = new Promise<"deadline">((resolve) => {
    deadlineTimer = setTimeout(() => {
      deadlineReached = true
      resolve("deadline")
    }, Math.max(0, input.deadlineMs ?? DEFAULT_DEADLINE_MS))
    deadlineTimer.unref?.()
  })
  const setup = (async (): Promise<ChildHandle | undefined> => {
    await input.setup()
    if (deadlineReached || input.state.cancelled) {
      input.onSetupSettled?.()
      return undefined
    }
    input.onSetupSettled?.()
    const taskRuntime = await import("#omo-task-runtime")
    const runner = input.createRunner?.(
      input.createSession === undefined ? {} : { createSession: input.createSession },
    ) ?? taskRuntime.createInProcessJudgeRunner(
      input.createSession === undefined ? {} : { createSession: input.createSession },
    )
    return runner.start(input.buildStart(taskRuntime))
  })()
  const setupResult = setup.then(
    (handle) => {
      if (handle === undefined) return undefined
      if (deadlineReached || input.state.cancelled) {
        void abortAndDispose(handle, input.logger, input.runId)
        return undefined
      }
      input.onHandle?.(handle)
      return handle
    },
    (error: unknown) => {
      if (deadlineReached || input.state.cancelled) return undefined
      throw error
    },
  )
  try {
    const settled = await Promise.race([setupResult, deadline, cancelled])
    if (settled === "deadline" || settled === undefined) {
      if (settled === "deadline") input.state.cancel?.()
      return { status: "failed", cause: settled === "deadline" ? "deadline" : "cancelled" }
    }
    const turn = await Promise.race([settled.waitForIdle(), deadline, cancelled])
    if (turn === "deadline" || turn === undefined) {
      input.state.cancelled = true
      await abortAndDispose(settled, input.logger, input.runId)
      return { status: "failed", cause: turn === "deadline" ? "deadline" : "cancelled" }
    }
    if (turn.status !== "completed") return { status: "failed", cause: "child_failed" }
    return { status: "completed" }
  } catch (error: unknown) {
    input.logger?.warn("memorian gate child session creation failed", {
      error: error instanceof Error ? error.message : String(error),
      runId: input.runId,
    })
    return { status: "failed", cause: "session_create_failed" }
  } finally {
    clearTimeout(deadlineTimer)
    input.state.cancel = undefined
    setupResult.then((handle) => handle?.dispose(), () => undefined)
  }
}
