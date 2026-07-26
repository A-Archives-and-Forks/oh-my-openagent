import type { ComponentContext, OmoSenpiComponent, SenpiExtensionAPI } from "../../extension/types"
import { SENPI_ULTRAWORK_DIRECTIVE } from "./generated-directive"

// `ulw(?!-)` keeps generous matching ("하이ulw", "ulw_helper.ts") while skipping the
// `ulw-` skill-name family (ulw-plan, ulw-loop, ulw-research): typing a skill name
// must not arm ultrawork mode on top of the skill itself.
const ULTRAWORK_CURRENT_PROMPT_PATTERN = /(?:ultrawork|ulw(?!-))/i
const ULTRAWORK_DISABLED_FLAG = "omo-senpi-ultrawork-disabled"
const ULTRAWORK_MODE_OPEN_TAG = "<ultrawork-mode>"
const ULTRAWORK_MODE_CLOSE_TAG = "</ultrawork-mode>"
const SKILL_COMMAND_PREFIX = "/skill:"
const ULTRAWORK_SKILL_NAME = "ultrawork"
const ULTRAWORK_CUSTOM_TYPE = "omo-ultrawork:directive"

type SenpiStreamingBehavior = "steer" | "followUp"

interface SenpiInputEvent {
  type: "input"
  text: string
  source: "interactive" | "rpc" | "extension"
  streamingBehavior?: SenpiStreamingBehavior
}

type SenpiInputEventResult = { action: "continue" }

export function createUltraworkComponent(): OmoSenpiComponent {
  return {
    name: "ultrawork",
    register(pi: SenpiExtensionAPI, ctx: ComponentContext): void {
      pi.on("input", (payload: unknown): SenpiInputEventResult => handleInput(pi, payload, ctx))
    },
  }
}

export function isUltraworkInput(text: string): boolean {
  return ULTRAWORK_CURRENT_PROMPT_PATTERN.test(text)
}

function handleInput(pi: SenpiExtensionAPI, payload: unknown, ctx: ComponentContext): SenpiInputEventResult {
  if (ctx.config.getFlag(ULTRAWORK_DISABLED_FLAG) === true) {
    return { action: "continue" }
  }

  if (!isSenpiInputEvent(payload)) {
    return { action: "continue" }
  }

  if (payload.source === "extension") {
    return { action: "continue" }
  }

  if (!isUltraworkInput(payload.text)) {
    return { action: "continue" }
  }

  // A pasted transcript (or an earlier injection) already carries the directive
  // block; injecting again would duplicate the same ~17KB of rules in one turn.
  // Require the matched tag PAIR: merely mentioning "<ultrawork-mode>" in a
  // question must not silently disarm a legitimate trigger.
  if (payload.text.includes(ULTRAWORK_MODE_OPEN_TAG) && payload.text.includes(ULTRAWORK_MODE_CLOSE_TAG)) {
    return { action: "continue" }
  }

  const streamingBehavior = readStreamingBehavior(payload.streamingBehavior)

  if (payload.text.startsWith(SKILL_COMMAND_PREFIX)) {
    // Mirror senpi's parse exactly: skill name runs to the FIRST space (or end).
    const spaceIndex = payload.text.indexOf(" ")
    const skillName = spaceIndex === -1 ? payload.text.slice(SKILL_COMMAND_PREFIX.length) : payload.text.slice(SKILL_COMMAND_PREFIX.length, spaceIndex)
    const args = spaceIndex === -1 ? "" : payload.text.slice(spaceIndex + 1)

    // `/skill:ultrawork` expansion already inlines the full SKILL.md, whose body
    // IS the directive block, so arming again would duplicate it in one turn.
    if (skillName === ULTRAWORK_SKILL_NAME) {
      return { action: "continue" }
    }

    // Arm only when the user's own words (the args) carry a trigger; a trigger
    // that appears solely inside the skill NAME must not arm the mode.
    if (!isUltraworkInput(args)) {
      return { action: "continue" }
    }
  }

  return injectDirective(pi, streamingBehavior)
}

/**
 * Arm ultrawork mode WITHOUT touching the user's text.
 *
 * The directive rides in as a hidden custom message: senpi converts custom
 * messages into `role: "user"` context (core/messages.ts `convertToLlm`) so the
 * model still receives every rule, while `display: false` keeps the TUI from
 * rendering ~17KB of directive above what the user actually typed
 * (interactive-mode renders `case "custom"` only when `message.display`).
 *
 * Leaving the text byte-identical also means senpi's native `/skill:` expansion,
 * which only fires while the prompt still STARTS with the command, can no longer
 * be disturbed by this hook.
 */
function injectDirective(pi: SenpiExtensionAPI, streamingBehavior: SenpiStreamingBehavior | undefined): SenpiInputEventResult {
  const message = {
    customType: ULTRAWORK_CUSTOM_TYPE,
    content: SENPI_ULTRAWORK_DIRECTIVE,
    display: false,
  }

  // Idle: senpi appends synchronously, landing the directive ahead of the user
  // message the `input` event is still gating. Queued: mirror the prompt's own
  // delivery so both enter the SAME queue in that order.
  if (streamingBehavior === undefined) {
    pi.sendMessage(message)
  } else {
    pi.sendMessage(message, { deliverAs: streamingBehavior })
  }

  return { action: "continue" }
}

function readStreamingBehavior(value: unknown): SenpiStreamingBehavior | undefined {
  return value === "steer" || value === "followUp" ? value : undefined
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
