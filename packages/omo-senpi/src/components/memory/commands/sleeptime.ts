// /sleeptime -- display the resolved memory settings for the bound identity.
//
// Senpi has no Ink overlay equivalent, so this is a read-only view plus the
// config-file path to edit and the manual "reflect now" and "dream" hints
// (porting note 10).

import type { SenpiExtensionAPI } from "../../../extension/types"
import { requireIdentity, respond, type MemoryCommandContext, type MemoryCommandDeps } from "./types"

const OVERRIDE_MARK = " [agent override]"

function mark(overridden: boolean): string {
  return overridden ? OVERRIDE_MARK : ""
}

export function registerSleeptimeCommand(pi: SenpiExtensionAPI, deps: MemoryCommandDeps): void {
  pi.registerCommand("sleeptime", {
    description: "Show the resolved sleeptime memory settings for this identity.",
    argumentHint: "",
    handler: async (_args: string, ctx: MemoryCommandContext): Promise<string> => {
      const identity = requireIdentity(deps, ctx)
      if (typeof identity === "string") return respond(ctx, identity, "error")

      const { settings, configPath } = deps.loadSettings()
      const agentId = identity.identity
      const agentOverride = settings.agents[agentId]

      // -- reflection --
      const baseReflection = settings.reflection
      const ovrReflection = agentOverride?.reflection
      const stepCount = ovrReflection?.trigger?.step_count ?? baseReflection.trigger.step_count
      const onCompaction = ovrReflection?.trigger?.on_compaction ?? baseReflection.trigger.on_compaction
      const merge = ovrReflection?.merge ?? baseReflection.merge
      const category = ovrReflection?.category ?? baseReflection.category
      const timeout = ovrReflection?.timeout_minutes ?? baseReflection.timeout_minutes
      const sandbox = ovrReflection?.sandbox ?? baseReflection.sandbox

      // -- nudge --
      const baseNudge = settings.nudge
      const ovrNudge = agentOverride?.nudge
      const nudgeEnabled = ovrNudge?.enabled ?? baseNudge.enabled
      const nudgeEvery = ovrNudge?.every_user_turns ?? baseNudge.every_user_turns

      // -- facts --
      const baseFacts = settings.facts
      const ovrFacts = agentOverride?.facts
      const factsEnabled = ovrFacts?.enabled ?? baseFacts.enabled
      const factsDebounce = ovrFacts?.debounce_settles ?? baseFacts.debounce_settles

      // -- dream --
      const baseDream = settings.dream
      const ovrDream = agentOverride?.dream
      const dreamEnabled = ovrDream?.enabled ?? baseDream.enabled
      const dreamIdle = ovrDream?.idle_minutes ?? baseDream.idle_minutes
      const dreamMinHours = ovrDream?.min_hours_between ?? baseDream.min_hours_between
      const dreamShutdown = ovrDream?.shutdown_launch ?? baseDream.shutdown_launch
      const dreamSelectMax = ovrDream?.auto_select_max ?? baseDream.auto_select_max

      // -- people --
      const basePeople = settings.people
      const ovrPeople = agentOverride?.people
      const peopleEnabled = ovrPeople?.enabled ?? basePeople.enabled
      const peopleMaxEntries = ovrPeople?.max_entries ?? basePeople.max_entries
      const peopleMaxChars = ovrPeople?.max_entry_chars ?? basePeople.max_entry_chars

      // -- soul --
      const baseSoul = settings.soul
      const ovrSoul = agentOverride?.soul
      const soulEditNotice = ovrSoul?.edit_notice ?? baseSoul.edit_notice

      const lines = [
        `# Sleeptime reflection: ${agentId}`,
        "",
        `Step trigger: ${stepCount > 0 ? `every ${stepCount} steps` : "off"}${mark(ovrReflection?.trigger?.step_count !== undefined)}`,
        `On compaction: ${onCompaction ? "on" : "off"}${mark(ovrReflection?.trigger?.on_compaction !== undefined)}`,
        `Merge policy: ${merge}${mark(ovrReflection?.merge !== undefined)}`,
        `Category: ${category}${mark(ovrReflection?.category !== undefined)}`,
        `Timeout: ${timeout} minutes${mark(ovrReflection?.timeout_minutes !== undefined)}`,
        `Sandbox: ${sandbox}${mark(ovrReflection?.sandbox !== undefined)}`,
        "",
        `Nudge: ${nudgeEnabled ? "on" : "off"}${mark(ovrNudge?.enabled !== undefined)}`,
        `Nudge every: every ${nudgeEvery} turns${mark(ovrNudge?.every_user_turns !== undefined)}`,
        "",
        `Facts: ${factsEnabled ? "on" : "off"}${mark(ovrFacts?.enabled !== undefined)}`,
        `Facts debounce: debounce ${factsDebounce} settles${mark(ovrFacts?.debounce_settles !== undefined)}`,
        "",
        `Dream: ${dreamEnabled ? "on" : "off"}${mark(ovrDream?.enabled !== undefined)}`,
        `Dream idle: idle ${dreamIdle} minutes${mark(ovrDream?.idle_minutes !== undefined)}`,
        `Dream spacing: min ${dreamMinHours}h between${mark(ovrDream?.min_hours_between !== undefined)}`,
        `Dream shutdown: shutdown launch ${dreamShutdown ? "on" : "off"}${mark(ovrDream?.shutdown_launch !== undefined)}`,
        `Dream select: select max ${dreamSelectMax}${mark(ovrDream?.auto_select_max !== undefined)}`,
        "",
        `People: ${peopleEnabled ? "on" : "off"}${mark(ovrPeople?.enabled !== undefined)}`,
        `People entries: max ${peopleMaxEntries} entries${mark(ovrPeople?.max_entries !== undefined)}`,
        `People chars: max ${peopleMaxChars} chars${mark(ovrPeople?.max_entry_chars !== undefined)}`,
        "",
        `Soul: edit notice ${soulEditNotice ? "on" : "off"}${mark(ovrSoul?.edit_notice !== undefined)}`,
        "",
        `Edit ${configPath ?? "your omo config file"} under memory.reflection, or memory.agents.${agentId} for this identity only.`,
        "Reflect now: /reflect [--recent N | --conversation <ids>] [focus]",
        "Dream now: /dream [--auto|--recent N|--conversation <ids>] [focus]",
      ]
      return respond(ctx, lines.join("\n"))
    },
  })
}
