import type { ReflectionChildResult } from "./spawn"
import type { ReflectionModelCandidate } from "./resolve-model"
import { isRetryableModelMiss } from "./model-miss"
import type { RunAttempt } from "./run-artifacts"

export type MemoryModelChain = readonly [
  ReflectionModelCandidate,
  ...ReflectionModelCandidate[],
]

export type MemoryModelAttempt = {
  readonly candidate: ReflectionModelCandidate
  readonly child: ReflectionChildResult
}

export async function runMemoryModelAttempts(
  candidates: MemoryModelChain,
  attempt: (
    candidate: ReflectionModelCandidate,
    attempt: number,
    nextAttempt: RunAttempt | undefined,
  ) => Promise<ReflectionChildResult>,
): Promise<MemoryModelAttempt> {
  for (const [index, candidate] of candidates.entries()) {
    const nextCandidate = candidates[index + 1]
    const nextAttempt = nextCandidate === undefined
      ? undefined
      : {
          attempt: index + 2,
          model: nextCandidate.model,
          ...(nextCandidate.thinking === undefined ? {} : { thinking: nextCandidate.thinking }),
        }
    const child = await attempt(candidate, index + 1, nextAttempt)
    const hasFallback = index < candidates.length - 1
    if (!hasFallback || !isRetryableModelMiss(child)) return { candidate, child }
  }

  throw new Error("Reflection model chain must contain a candidate")
}
