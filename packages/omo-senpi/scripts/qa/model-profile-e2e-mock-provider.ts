#!/usr/bin/env node
// Lane-private wrapper around task-e2e-mock-provider.ts for model-profile-e2e.mjs.
// Unrelated QA keeps reasoning:false. This wrapper only advertises graded thinking
// and records the thinking level senpi actually sends into streamSimple.
import registerTaskE2eMockProvider from "./task-e2e-mock-provider.ts"

declare const process: {
  cwd(): string
  env: Record<string, string | undefined>
  getBuiltinModule<T>(id: string): T
}

interface FsModule {
  appendFileSync(path: string, data: string): void
}

interface PathModule {
  join(...paths: string[]): string
}

const { appendFileSync } = process.getBuiltinModule<FsModule>("fs")
const { join } = process.getBuiltinModule<PathModule>("path")

export const CAPTURES_FILE = "model-profile-stream-captures.jsonl"

const THINKING_LEVELS = {
  off: "off",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
} as const

type TaskE2EExtensionAPI = Parameters<typeof registerTaskE2eMockProvider>[0]
type MockProvider = Parameters<TaskE2EExtensionAPI["registerProvider"]>[1]
type StreamSimple = MockProvider["streamSimple"]

function readThinking(source: unknown): string | null {
  if (typeof source !== "object" || source === null) return null
  for (const key of ["thinkingLevel", "thinking_level", "reasoning_effort", "reasoning"] as const) {
    const value = Reflect.get(source, key)
    if (typeof value === "string") return value
    if (typeof value === "object" && value !== null) {
      const nested = Reflect.get(value, "effort") ?? Reflect.get(value, "level")
      if (typeof nested === "string") return nested
    }
  }
  return null
}

function withReasoning(model: MockProvider["models"][number]): MockProvider["models"][number] {
  return {
    ...model,
    reasoning: true,
    thinkingLevelMap: THINKING_LEVELS,
  }
}

function appendCapture(record: Record<string, unknown>): void {
  appendFileSync(join(process.cwd(), CAPTURES_FILE), `${JSON.stringify(record)}\n`)
}

function wrapStreamSimple(providerId: string, original: StreamSimple): StreamSimple {
  return ((model, context, options) => {
    appendCapture({
      provider: providerId,
      model: typeof model === "object" && model !== null ? Reflect.get(model, "id") ?? null : null,
      thinking:
        readThinking(options) ??
        readThinking(context) ??
        readThinking(model) ??
        null,
      optionKeys: typeof options === "object" && options !== null ? Object.keys(options) : [],
      contextKeys: typeof context === "object" && context !== null ? Object.keys(context) : [],
    })
    return original(model, context, options)
  }) as StreamSimple
}

export default function registerModelProfileMockProvider(pi: TaskE2EExtensionAPI): void {
  const registerProvider: TaskE2EExtensionAPI["registerProvider"] = (id, provider) => {
    const wrapped: MockProvider = {
      ...provider,
      models: provider.models.map(withReasoning),
      streamSimple: wrapStreamSimple(id, provider.streamSimple.bind(provider)),
    }
    pi.registerProvider(id, wrapped)
    if (id === "omo-mock" && process.env.OMO_PROFILE_QA_REGISTER_OPENAI === "1") {
      pi.registerProvider("openai", {
        ...wrapped,
        name: "openai fixture",
        streamSimple: wrapStreamSimple("openai", provider.streamSimple.bind(provider)),
      })
    }
  }
  registerTaskE2eMockProvider(
    new Proxy(pi, {
      get(target, property, receiver) {
        if (property === "registerProvider") return registerProvider
        return Reflect.get(target, property, receiver)
      },
    }),
  )
}
