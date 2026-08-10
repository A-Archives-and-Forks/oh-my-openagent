import type { ComponentContext, ComponentLogger, SenpiExtensionAPI } from "../../extension/types"
import type { SenpiOmoConfigResult } from "../config-resolution"
import type { MemoryIdentityContext } from "./context"
import type { MemoryIdentityRuntime, MemoryIdentityRuntimeDeps } from "./identity-runtime"
import type { ShutdownDrainInput, ShutdownEvaluator } from "./shutdown-drain"

export interface MemorySessionStateLike {
  readonly context?: MemoryIdentityContext
}

export interface MemoryWiringOptions {
  readonly sessions: Map<string, MemorySessionStateLike>
  readonly loadConfig: (options: { readonly cwd?: string }) => SenpiOmoConfigResult
  readonly cwd: () => string
  readonly env: Record<string, string | undefined>
  readonly logger?: ComponentLogger
  readonly createRuntime?: (identity: MemoryIdentityContext, deps: MemoryIdentityRuntimeDeps) => MemoryIdentityRuntime
  /** Boot-snapshot tool exposure; registration must not re-read config (latch order is observable). */
  readonly toolExposure?: "direct" | "search"
}

export interface MemoryWiring {
  registerStatic(pi: SenpiExtensionAPI, ctx: ComponentContext): void
  afterBind(pi: SenpiExtensionAPI, sessionId: string, identity: MemoryIdentityContext, eventCtx: unknown): Promise<void>
  flushSkillsUsage(): Promise<void>
  /** IC-10: bounded drain the session_shutdown handler awaits before the session is released. */
  onSessionShutdown(input: ShutdownDrainInput): Promise<void>
  /** IC-10: appends an evaluator run last on quit; unregistered is a no-op. */
  registerShutdownEvaluator(evaluator: ShutdownEvaluator): void
}

export type StatusUi = {
  setStatus(key: string, text?: string): void
  notify(message: string, level: "info" | "warning" | "error"): void
}
