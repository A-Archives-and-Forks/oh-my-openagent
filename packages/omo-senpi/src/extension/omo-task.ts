import { InProcessRunner, findModelReference } from "@oh-my-opencode/senpi-task"
import type { InProcessRunnerOptions, InProcessRunnerLike } from "@oh-my-opencode/senpi-task"

export { createTaskComponent } from "../components/task"
export { findModelReference }
export type { InProcessRunnerLike }

export function createInProcessJudgeRunner(options: InProcessRunnerOptions = {}): InProcessRunnerLike {
  return new InProcessRunner(options)
}
