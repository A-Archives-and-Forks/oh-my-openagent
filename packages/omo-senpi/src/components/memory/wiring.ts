import { join } from "node:path"

import { MemoryBlockCache } from "@oh-my-opencode/memory-core"

import type { ComponentContext, SenpiExtensionAPI } from "../../extension/types"
import { hasMemoryCapabilities } from "./capabilities"
import type { MemoryIdentityContext } from "./context"
import { createDreamTriggerWiring, resolveDreamTriggerSettings } from "./dream-trigger"
import { resolveMemorySettings } from "./identity-runtime"
import { createMemoryNudgeWiring } from "./nudge-wiring"
import type { PalacePeopleOptions } from "./palace/people"
import { registerMemoryFilesystemPolicy } from "./policy-guard"
import { createShutdownDrain, type ShutdownDrainInput, type ShutdownEvaluator } from "./shutdown-drain"
import { type SkillsUsageTracker } from "./skills-usage"
import { createSoulNoticeWiring } from "./soul-notice"
import { MEMORY_STATUS_KEY, refreshMemoryStatus } from "./status"
import {
  consumePendingReflectionCompletions,
  type ReflectionCompletionApi,
} from "./worker"
import { branchEntryCount, readUi } from "./wiring-context"
import { createMemoryRuntimeWiring } from "./wiring-runtime"
import { registerMemoryStatic } from "./wiring-static"
import type { MemoryCommandSettings } from "./commands/types"
import type { MemoryWiring, MemoryWiringOptions } from "./wiring-types"

export type { MemorySessionStateLike, MemoryWiring, MemoryWiringOptions } from "./wiring-types"

export function createMemoryWiring(options: MemoryWiringOptions): MemoryWiring {
  const promptCache = new MemoryBlockCache()
  const lastEventCtx: { current?: unknown } = {}
  const activeSession: { current?: string } = {}
  const skillsUsageTrackersRef: { current: Map<string, SkillsUsageTracker> } = { current: new Map() }
  const runtimeWiring = createMemoryRuntimeWiring(options, lastEventCtx)
  const { resolveContext, journalWiringFor, factsWiringFor, runtimeFor } = runtimeWiring

  const nudgeWiring = createMemoryNudgeWiring({
    resolveContext,
    resolveSettings: (identity) => {
      const settings = resolveMemorySettings(options.loadConfig({ cwd: options.cwd() }).config.memory)
      const override = settings.agents[identity]?.nudge
      return {
        enabled: override?.enabled ?? settings.nudge.enabled,
        everyUserTurns: override?.every_user_turns ?? settings.nudge.every_user_turns,
      }
    },
  })
  const soulNoticeWiring = createSoulNoticeWiring({
    resolveContext,
    resolveEditNotice: (identity) => {
      const settings = resolveMemorySettings(options.loadConfig({ cwd: options.cwd() }).config.memory)
      const override = settings.agents[identity]?.soul
      return override?.edit_notice ?? settings.soul.edit_notice
    },
  })

  async function flushSkillsUsageTrackers(signal?: AbortSignal): Promise<void> {
    for (const tracker of skillsUsageTrackersRef.current.values()) {
      if (signal?.aborted === true) return
      await tracker.flush(signal)
    }
  }

  const shutdownDrain = createShutdownDrain({
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    steps: {
      flushJournal: async (sessionId, signal) => {
        const identity = resolveContext(sessionId)
        if (identity === undefined) return
        await journalWiringFor(identity).journalFor(sessionId).flush(signal)
      },
      enqueueFinalDelta: async (sessionId, signal) => {
        const identity = resolveContext(sessionId)
        if (identity === undefined || signal.aborted) return
        await factsWiringFor(identity).enqueueSettled(sessionId, signal)
      },
      flushSkillsUsage: async (_sessionId, signal) => {
        if (signal.aborted) return
        await flushSkillsUsageTrackers(signal)
      },
      launchFacts: async (sessionId, signal) => {
        const identity = resolveContext(sessionId)
        if (identity === undefined || signal.aborted) return
        await factsWiringFor(identity).launchIfThresholdMet(signal)
      },
    },
  })

  const dreamTriggerWiring = createDreamTriggerWiring({
    resolveSession: (eventCtx) => runtimeWiring.dreamSessionFor(eventCtx),
    resolveActiveSession: () => (activeSession.current === undefined ? undefined : runtimeWiring.dreamSessionById(activeSession.current)),
    resolveSessionById: runtimeWiring.dreamSessionById,
    resolveSettings: (identity) => {
      const settings = resolveMemorySettings(options.loadConfig({ cwd: options.cwd() }).config.memory)
      return resolveDreamTriggerSettings(settings, identity)
    },
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  })
  shutdownDrain.registerEvaluator(dreamTriggerWiring.shutdownEvaluator())

  function completionApi(pi: SenpiExtensionAPI): ReflectionCompletionApi | undefined {
    if (!hasMemoryCapabilities(pi)) return undefined
    return {
      appendEntry: (customType, data) => {
        pi.appendEntry(customType, data)
      },
      registerEntryRenderer: (customType, renderer) => {
        pi.registerEntryRenderer(customType, renderer)
      },
    }
  }

  /** Palace people-panel gate using the resolved `memory.people` settings. */
  function resolvePalacePeople(): PalacePeopleOptions | undefined {
    const people = resolveMemorySettings(options.loadConfig({ cwd: options.cwd() }).config.memory).people
    return {
      enabled: people.enabled,
      limits: { maxEntries: people.max_entries, maxEntryChars: people.max_entry_chars },
    }
  }

  function loadCommandSettings(): MemoryCommandSettings {
    const resolved = options.loadConfig({ cwd: options.cwd() }).config
    return { settings: resolveMemorySettings(resolved.memory), config: resolved }
  }

  return {
    registerStatic(pi: SenpiExtensionAPI, ctx: ComponentContext): void {
      registerMemoryStatic({
        pi,
        ctx,
        options,
        promptCache,
        nudgeWiring,
        soulNoticeWiring,
        dreamTriggerWiring,
        completionApi,
        resolveContext,
        journalWiringFor,
        factsWiringFor,
        runtimeFor,
        triggerSessionFor: runtimeWiring.triggerSessionFor,
        resolvePalacePeople,
        loadCommandSettings,
        lastEventCtx,
        activeSession,
        skillsUsageTrackersRef,
      })
    },

    async afterBind(pi: SenpiExtensionAPI, sessionId: string, identity: MemoryIdentityContext, eventCtx: unknown): Promise<void> {
      activeSession.current = sessionId
      lastEventCtx.current = eventCtx
      registerMemoryFilesystemPolicy(pi, identity)
      await runtimeFor(identity).reconcile()
      if (branchEntryCount(eventCtx) > 0) {
        await journalWiringFor(identity).reconcileSession(eventCtx)
      }
      factsWiringFor(identity).reconcileExtractor()
      const ui = readUi(eventCtx)
      if (ui !== undefined) {
        const settings = resolveMemorySettings(options.loadConfig({ cwd: options.cwd() }).config.memory)
        void refreshMemoryStatus({
          context: identity,
          ui,
          compileWarnTokens: settings.compile_warn_tokens,
          alreadyNotified: false,
        }).catch(() => {})
      }
      const api = completionApi(pi)
      if (api !== undefined) {
        void consumePendingReflectionCompletions(
          join(identity.identityPaths.reflection, "completions"),
          { sessionId, api },
        ).catch(() => {})
      }
    },

    async flushSkillsUsage(): Promise<void> {
      await flushSkillsUsageTrackers()
    },

    async onSessionShutdown(input: ShutdownDrainInput): Promise<void> {
      await shutdownDrain.run(input)
    },

    registerShutdownEvaluator(evaluator: ShutdownEvaluator): void {
      shutdownDrain.registerEvaluator(evaluator)
    },

    clearStatus(eventCtx: unknown): void {
      readUi(eventCtx)?.setStatus(MEMORY_STATUS_KEY, undefined)
    },
  }
}
