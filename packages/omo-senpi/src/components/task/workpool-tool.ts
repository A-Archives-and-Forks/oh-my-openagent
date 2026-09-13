import { createWorkpoolTool } from "@oh-my-opencode/senpi-task"
import type { SenpiExtensionAPI } from "../../extension/types"
import type { TaskEngine } from "./engine"
import type { SkillInvocationTracker } from "./skill-invocation-tracker"

export function registerWorkpoolTool(pi: SenpiExtensionAPI, engine: TaskEngine, skills: SkillInvocationTracker): void {
  const workpools = engine.manager.workpools
  if (workpools === undefined) throw new Error("Task engine does not expose workpool admission")
  pi.registerTool({ ...createWorkpoolTool({
    manager: engine.manager, workpools, omoConfig: engine.omoConfig, agents: engine.agents,
    resolveSkillInvocations: sessionId => skills.stateFor(sessionId),
  }) })
  pi.on("session_shutdown", () => workpools.dispose())
}
