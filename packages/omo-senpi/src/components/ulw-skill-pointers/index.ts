import type { ComponentContext, OmoSenpiComponent, SenpiExtensionAPI } from "../../extension/types"
import { getBuiltinSkillsRoot } from "../telemetry/product-identity"

export const ULW_LOOP_CUSTOM_TYPE = "omo-ulw-loop:skill-pointer"
export const ULW_RESEARCH_CUSTOM_TYPE = "omo-ulw-research:skill-pointer"
export const ULW_SKILL_POINTERS_DISABLED_FLAG = "omo-senpi-ulw-skill-pointers-disabled"

const SKILL_COMMAND_PREFIX = "/skill:"

interface UlwSkillPointerTarget {
  readonly skillName: string
  readonly customType: string
  readonly pattern: RegExp
  readonly expandedBlockPattern: RegExp
  readonly summary: string
}

// Composite invocations ("mass ulw loop", "mass ulw research") must load EVERY matching
// surface at once: ultrawork arms on `ulw`, mass-ulw fires on `mass ulw`, and these
// patterns load the named skill itself. `\b` on both edges keeps `mulw loop`,
// `ulw-looper`, and `ulwloops` from matching; `[\s-]*` accepts `ulw loop`, `ulw-loop`,
// and `ulwloop` alike.
const TARGETS: readonly UlwSkillPointerTarget[] = [
  {
    skillName: "ulw-loop",
    customType: ULW_LOOP_CUSTOM_TYPE,
    pattern: /\bulw[\s-]*loop\b/i,
    expandedBlockPattern: /<skill\s+name="ulw-loop"/i,
    summary: "run the goal-driven ultrawork loop with evidence-bound execution",
  },
  {
    skillName: "ulw-research",
    customType: ULW_RESEARCH_CUSTOM_TYPE,
    pattern: /\bulw[\s-]*research\b/i,
    expandedBlockPattern: /<skill\s+name="ulw-research"/i,
    summary: "orchestrate team-first maximum-saturation research",
  },
]

interface SenpiInputEvent {
  type: "input"
  text: string
  source: "interactive" | "rpc" | "extension"
  streamingBehavior?: "steer" | "followUp"
}

type SenpiInputEventResult = { action: "continue" } | { action: "transform"; text: string }

export function matchedUlwSkillNames(text: string): string[] {
  return TARGETS.filter((target) => target.pattern.test(text)).map((target) => target.skillName)
}

export function createUlwSkillPointersComponent(): OmoSenpiComponent {
  return {
    name: "ulw-skill-pointers",
    register(pi: SenpiExtensionAPI, ctx: ComponentContext): void {
      pi.on("input", (payload: unknown): SenpiInputEventResult => handleInput(pi, payload, ctx))
    },
  }
}

function handleInput(pi: SenpiExtensionAPI, payload: unknown, ctx: ComponentContext): SenpiInputEventResult {
  if (ctx.config.getFlag(ULW_SKILL_POINTERS_DISABLED_FLAG) === true) {
    return { action: "continue" }
  }

  if (!isSenpiInputEvent(payload)) {
    return { action: "continue" }
  }

  if (payload.source === "extension") {
    return { action: "continue" }
  }

  const commandSkillName = skillCommandName(payload.text)
  const targets = TARGETS.filter(
    (target) =>
      target.pattern.test(payload.text) &&
      target.skillName !== commandSkillName &&
      !target.expandedBlockPattern.test(payload.text),
  )

  if (targets.length === 0) {
    return { action: "continue" }
  }

  // A queued prompt carries the pointers inside its own message so the group stays atomic
  // through senpi's one-at-a-time queue drain; appending keeps a leading `/skill:` command
  // expandable.
  if (payload.streamingBehavior !== undefined) {
    const pointers = targets.map((target) => skillPointer(target))
    return { action: "transform", text: [payload.text, ...pointers].join("\n") }
  }

  for (const target of targets) {
    pi.sendMessage({
      customType: target.customType,
      content: skillPointer(target),
      display: false,
    })
  }

  return { action: "continue" }
}

function skillPointer(target: UlwSkillPointerTarget): string {
  const skillsRoot = getBuiltinSkillsRoot()
  return `<omo-${target.skillName}-pointer>The user asked for ${target.skillName}. Read the ${target.skillName} skill at ${skillsRoot}${target.skillName}/SKILL.md with the read tool and follow it: ${target.summary}.</omo-${target.skillName}-pointer>`
}

function skillCommandName(text: string): string | undefined {
  if (!text.startsWith(SKILL_COMMAND_PREFIX)) {
    return undefined
  }

  const spaceIndex = text.indexOf(" ")
  return spaceIndex === -1 ? text.slice(SKILL_COMMAND_PREFIX.length) : text.slice(SKILL_COMMAND_PREFIX.length, spaceIndex)
}

function isSenpiInputEvent(value: unknown): value is SenpiInputEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false
  }

  const candidate = value as Record<string, unknown>
  if (candidate["type"] !== "input") {
    return false
  }

  if (typeof candidate["text"] !== "string" || candidate["text"].length === 0) {
    return false
  }

  return candidate["source"] === "interactive" || candidate["source"] === "rpc" || candidate["source"] === "extension"
}
