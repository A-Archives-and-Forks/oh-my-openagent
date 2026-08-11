export type ModelMissResult = {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
}

const MODEL_NOT_FOUND_PATTERN = /^Error: Model ".+" not found\. Use --list-models to see available models\.$/m

export function isRetryableModelMiss(result: ModelMissResult): boolean {
  if (result.timedOut || result.code === 0) return false
  return MODEL_NOT_FOUND_PATTERN.test(result.stderr) || MODEL_NOT_FOUND_PATTERN.test(result.stdout)
}
