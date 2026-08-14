export function resolveParentContextTokens(eventContext: unknown): number | undefined {
  if (!isRecord(eventContext)) return undefined
  const getter = eventContext.getContextUsage
  if (typeof getter !== "function") return undefined
  const usage = Reflect.apply(getter, eventContext, [])
  if (!isRecord(usage)) return undefined
  const tokens = usage.tokens
  return typeof tokens === "number" && tokens > 0 ? tokens : undefined
}

export function resolveParentSessionFile(eventContext: unknown): string | undefined {
  if (!isRecord(eventContext)) return undefined
  const manager = eventContext.sessionManager
  if (!isRecord(manager)) return undefined
  const getter = manager.getSessionFile
  if (typeof getter !== "function") return undefined
  const file = Reflect.apply(getter, manager, [])
  return typeof file === "string" && file.length > 0 ? file : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
