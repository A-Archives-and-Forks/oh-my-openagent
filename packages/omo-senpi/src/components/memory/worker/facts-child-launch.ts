import type { FactsPayload } from "@oh-my-opencode/memory-core"

import { runMemoryModelAttempts, type MemoryModelChain } from "./memory-model-attempts"
import type { ReflectionModelResolution } from "./resolve-model"
import {
  prepareFactsSpawn,
  runFactsChild,
  type FactsSandbox,
} from "./spawn"

type FactsChildLaunchInput = {
  readonly runId: string
  readonly runDir: string
  readonly payload: FactsPayload
  readonly resolution: Extract<ReflectionModelResolution, { readonly kind: "resolved" }>
  readonly env: NodeJS.ProcessEnv
  readonly senpiCommand?: string
  readonly hardDeadlineAt: number
  readonly terminationGraceMs?: number
  readonly maxOutputBytes?: number
  readonly sandbox?: FactsSandbox
  readonly supervisorPath?: string
  readonly batchId: string
  readonly queued: readonly { readonly conversationId: string; readonly end_message_id: string }[]
  readonly launchedAt: number
}

export async function launchFactsModelChain(input: FactsChildLaunchInput) {
  const candidates: MemoryModelChain = [
    {
      model: input.resolution.model,
      ...(input.resolution.thinking === undefined ? {} : { thinking: input.resolution.thinking }),
    },
    ...input.resolution.fallbacks,
  ]
  return runMemoryModelAttempts(candidates, async (candidate, attempt, nextAttempt) => {
    const spawnArgs = await prepareFactsSpawn({
      runId: input.runId,
      runDir: input.runDir,
      payload: input.payload,
      model: candidate.model,
      thinking: candidate.thinking,
      attempt,
      hardDeadlineAt: input.hardDeadlineAt,
      nextAttempt,
      env: input.env,
      senpiCommand: input.senpiCommand,
    })
    return runFactsChild(spawnArgs, {
      terminationGraceMs: input.terminationGraceMs,
      maxOutputBytes: input.maxOutputBytes,
      sandbox: input.sandbox,
      supervisorPath: input.supervisorPath,
      batchId: input.batchId,
      queued: input.queued,
      now: () => input.launchedAt,
    })
  })
}
