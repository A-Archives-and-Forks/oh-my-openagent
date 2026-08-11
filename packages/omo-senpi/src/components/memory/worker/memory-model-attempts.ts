import type { ReflectionChildResult } from "./spawn"
import type { ReflectionModelCandidate } from "./resolve-model"

export type MemoryModelChain = readonly [
  ReflectionModelCandidate,
  ...ReflectionModelCandidate[],
]

export type MemoryModelAttempt = {
  readonly candidate: ReflectionModelCandidate
  readonly child: ReflectionChildResult
}

const MODEL_NOT_FOUND_PATTERN = /^Error: Model ".+" not found\. Use --list-models to see available models\.$/m

export async function runMemoryModelAttempts(
  candidates: MemoryModelChain,
  attempt: (candidate: ReflectionModelCandidate) => Promise<ReflectionChildResult>,
): Promise<MemoryModelAttempt> {
  for (const [index, candidate] of candidates.entries()) {
    const child = await attempt(candidate)
    const hasFallback = index < candidates.length - 1
    if (!hasFallback || !isRetryableModelMiss(child)) return { candidate, child }
  }

  throw new Error("Reflection model chain must contain a candidate")
}

function isRetryableModelMiss(child: ReflectionChildResult): boolean {
  if (child.timedOut || child.code === 0) return false
  return MODEL_NOT_FOUND_PATTERN.test(child.stderr) || MODEL_NOT_FOUND_PATTERN.test(child.stdout)
}
