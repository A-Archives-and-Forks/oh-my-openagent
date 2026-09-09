// Continuation is not error recovery: Senpi owns retries, fallback and abort handling.
// AgentEndEvent requires messages; absent outcome data must not become a clean stop.
export function canContinueAfterAgentEnd(payload: unknown): boolean {
  if (!isRecord(payload) || payload["aborted"] === true || payload["willRetry"] === true) return false
  const messages = payload["messages"]
  if (!Array.isArray(messages)) return false
  const assistant: unknown = messages.findLast((message: unknown) => isRecord(message) && message["role"] === "assistant")
  if (!isRecord(assistant)) return false

  // Senpi can normalize an empty toolUse to stop while retaining the refusal details.
  const details = assistant["stopDetails"]
  if (isRecord(details) && (details["type"] === "refusal" || details["type"] === "sensitive")) return false

  switch (assistant["stopReason"]) {
    case "stop":
    case "length":
    case "toolUse":
      return true
    default:
      return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
