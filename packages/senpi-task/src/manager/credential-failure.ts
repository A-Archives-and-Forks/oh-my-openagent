import type { ResolvedModelRecord, TaskRecord } from "../state"

// A provider answer that no other model on the SAME provider can fix: the stored credential is
// rejected (401/403, a lapsed subscription) or can no longer be refreshed. Every remaining rung on
// that provider would fail the same way, so runtime fallback moves on to another provider.
const CREDENTIAL_FAILURE =
  /\b(?:401|403)\b|unauthori[sz]ed|forbidden|invalid_grant|oauth refresh failed|subscription is required|invalid api key|incorrect api key|authentication (?:failed|error)/i

export function isCredentialFailure(message: string): boolean {
  return CREDENTIAL_FAILURE.test(message)
}

function providerOf(record: TaskRecord): string | undefined {
  if (record.resolved_model !== undefined) return record.resolved_model.provider
  const separator = record.model.indexOf("/")
  return separator > 0 ? record.model.slice(0, separator) : undefined
}

// The task manager has no session surface of its own (a desktop client, a headless run and the
// terminal all delegate), so the recovery names both re-authentication paths instead of a slash
// command only the interactive terminal handles.
/** The terminal error text: a credential failure names the provider and how to restore it. */
export function terminalFailureMessage(record: TaskRecord | null | undefined, failureMessage: string): string {
  const provider = record == null ? undefined : providerOf(record)
  if (provider === undefined || !isCredentialFailure(failureMessage)) return failureMessage
  return `${failureMessage}\nCredentials for ${provider} were rejected; re-authenticate ${provider} (Provider authentication settings on the desktop, /login ${provider} in an interactive session) or re-add its API key, or pin this category to another provider in omo.json.`
}

export type RuntimeFallbackCandidates = {
  readonly remaining: readonly ResolvedModelRecord[]
  readonly skipped: readonly ResolvedModelRecord[]
}

/** The fallback list to walk after a failed turn, minus the failed provider's rungs when its credential is dead. */
export function runtimeFallbackCandidates(record: TaskRecord, failureMessage: string): RuntimeFallbackCandidates {
  const fallbacks = record.fallback_models ?? []
  const provider = providerOf(record)
  if (provider === undefined || !isCredentialFailure(failureMessage)) return { remaining: fallbacks, skipped: [] }
  return {
    remaining: fallbacks.filter((model) => model.provider !== provider),
    skipped: fallbacks.filter((model) => model.provider === provider),
  }
}
