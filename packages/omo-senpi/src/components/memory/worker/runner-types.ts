import type { MemoryIdentity, ReflectionOutcome, ReservedRun } from "@oh-my-opencode/memory-core"
import type { SenpiModelPort, SenpiModelRegistryPort } from "@oh-my-opencode/senpi-task"

import type { SenpiOmoConfigResult } from "../../config-resolution"
import type { ReflectionCompletionRecord, ReflectionLiveSession } from "./completion"
import type { ReflectionThinkingLevel } from "./resolve-model"
import type { ReflectionSandbox } from "./spawn"

export interface ReflectionReservationPort {
  readState(): Promise<{ readonly active?: ReservedRun }>
  complete(
    runId: string,
    outcome: ReflectionOutcome,
  ): Promise<{ readonly outcome: ReflectionOutcome; readonly launch?: ReservedRun }>
}

export interface ReflectionRunResult {
  readonly runId: string
  readonly outcome: ReflectionOutcome
  readonly reason?: string
  readonly detail?: string
  readonly completion: ReflectionCompletionRecord
  readonly launch?: ReservedRun
}

export interface ReflectionRunner {
  launch(request: ReservedRun): Promise<ReflectionRunResult>
}

export interface SenpiSubprocessRunnerOptions {
  readonly identity: MemoryIdentity
  readonly reservation: ReflectionReservationPort
  readonly resolveModelRegistry: () => SenpiModelRegistryPort<SenpiModelPort> | undefined
  readonly loadConfig?: (options?: { readonly cwd?: string }) => SenpiOmoConfigResult
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
  readonly deadlineMs?: number
  readonly terminationGraceMs?: number
  readonly maxOutputBytes?: number
  readonly sandbox?: ReflectionSandbox
  readonly liveSession?: () => ReflectionLiveSession | undefined
  readonly now?: () => Date
  readonly senpiCommand?: string
  readonly supervisorPath?: string
  readonly withWriterLock?: <T>(operation: () => Promise<T>) => Promise<T>
}

export type ExecutionResult = {
  readonly outcome: ReflectionOutcome
  readonly reason?: string
  readonly detail?: string
  readonly model?: string
  readonly thinking?: ReflectionThinkingLevel
}
