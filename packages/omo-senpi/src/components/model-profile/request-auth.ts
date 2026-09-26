/**
 * Session-start emulation of the first turn's request-auth resolution for one profile candidate.
 *
 * senpi resolves auth lazily, on the first request, and `modelRegistry.getAvailable()` lists every
 * provider with STORED credentials - including an OAuth login whose refresh token the provider now
 * rejects. The first turn goes through `ModelRuntime.streamSimple`, which (a) rotates over a
 * provider's credential SLOTS when it holds more than one account (a pinned account wins), and (b)
 * resolves the model's own configured headers on top of the provider credential. Both are
 * reproduced here through the public `ModelRuntime.getAuth` overloads so the walk skips exactly
 * what that turn could not use:
 *
 *   - provider scope: no eligible slot resolves (`refresh`: the stored login could not be
 *     refreshed; `credentials`: any other resolution failure, e.g. a failing `!command` key);
 *   - model scope (`request`): the provider credential resolved but this model's request
 *     configuration did not, so only that candidate is skipped and its siblings stay eligible.
 *
 * Cost: each probe is the resolution the first turn would perform anyway (a token with less than
 * five minutes left is refreshed; a rejected refresh costs up to senpi's exchange timeout per
 * slot), and the walk is sequential. Raw errors carry URLs, response bodies and shell commands, so
 * only a class/code fingerprint leaves this module; `sanitizedAuthErrorDetail` is for opt-in
 * diagnostics.
 */

export type AuthFailureReason = "refresh" | "credentials" | "request"

export type AuthFailure = {
  readonly provider: string
  readonly model: string
  readonly reason: AuthFailureReason
  /** Error class and code only (for example `ModelsError/oauth`), never the message. */
  readonly errorKind: string
  /** The thrown value, kept for opt-in diagnostics; never serialized into notices or details. */
  readonly error: unknown
}

type AuthOverrides = { readonly slotName?: string }

export type ProbeRuntime = {
  getAuth(target: unknown, overrides?: AuthOverrides): Promise<unknown>
}

/** The subset of senpi's `ModelRegistry` the probe reads; every member is optional so a host without it degrades. */
export type ProbeRegistry = {
  readonly modelRuntime?: unknown
  readonly authStorage?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

export function probeRuntime(registry: ProbeRegistry): ProbeRuntime | undefined {
  const runtime = registry.modelRuntime
  if (!isRecord(runtime) || typeof runtime["getAuth"] !== "function") return undefined
  return runtime as unknown as ProbeRuntime
}

type CredentialSlots = { readonly names: readonly string[]; readonly pinned: string | undefined }

// Mirrors senpi's pool reading: a credential with an `accounts` array is a pool of named slots and
// `pinned` names the only slot rotation may use; anything else is the flat single credential.
function credentialSlots(registry: ProbeRegistry, provider: string): CredentialSlots {
  const storage = registry.authStorage
  if (!isRecord(storage) || typeof storage["get"] !== "function") return { names: [], pinned: undefined }
  const credential: unknown = Reflect.apply(storage["get"], storage, [provider])
  if (!isRecord(credential) || !Array.isArray(credential["accounts"])) return { names: [], pinned: undefined }
  const names = credential["accounts"]
    .map((account: unknown) => (isRecord(account) && typeof account["name"] === "string" ? account["name"] : undefined))
    .filter((name): name is string => name !== undefined)
  const pinned = credential["pinned"]
  return { names, pinned: typeof pinned === "string" && names.includes(pinned) ? pinned : undefined }
}

function errorKind(error: unknown): string {
  if (!(error instanceof Error)) return typeof error
  const code = (error as Error & { code?: unknown }).code
  return typeof code === "string" ? `${error.name}/${code}` : error.name
}

function providerFailureReason(error: unknown): AuthFailureReason {
  // senpi maps every OAuth refresh failure (rejected token, network error, exchange timeout) onto
  // `ModelsError` code "oauth"; the message is not inspected, so a transient failure is reported
  // with the same neutral guidance as a rejected one.
  return error instanceof Error && (error as Error & { code?: unknown }).code === "oauth" ? "refresh" : "credentials"
}

/**
 * Returns the failure that would stop the first turn on this candidate, or `undefined` when the
 * candidate is usable. `model` is the registry's model object for `provider`/`modelId`.
 */
export async function probeRequestAuth(
  registry: ProbeRegistry,
  runtime: ProbeRuntime,
  provider: string,
  modelId: string,
  model: unknown,
): Promise<AuthFailure | undefined> {
  const slots = credentialSlots(registry, provider)
  // Rotation order: a pin is the only slot the engine uses; otherwise any healthy slot serves.
  const candidates: (string | undefined)[] =
    slots.pinned !== undefined ? [slots.pinned] : slots.names.length > 0 ? [...slots.names] : [undefined]

  let resolvedSlot: string | undefined
  let resolved = false
  let lastError: unknown
  for (const slot of candidates) {
    try {
      // `undefined` here means the provider needs no credential (headers-only compatibility
      // config), which the first turn also accepts; only a throw is a failure.
      await runtime.getAuth(provider, slot === undefined ? {} : { slotName: slot })
      resolved = true
      resolvedSlot = slot
      break
    } catch (error) {
      lastError = error
    }
  }
  if (!resolved) {
    return { provider, model: modelId, reason: providerFailureReason(lastError), errorKind: errorKind(lastError), error: lastError }
  }

  try {
    await runtime.getAuth(model, resolvedSlot === undefined ? {} : { slotName: resolvedSlot })
  } catch (error) {
    return { provider, model: modelId, reason: "request", errorKind: errorKind(error), error }
  }
  return undefined
}

const DETAIL_MAX_LENGTH = 240

// One redacted line per error in the cause chain. Shell commands and response bodies are dropped
// whole (a `!command` key or header can embed a secret), key/token-shaped assignments and long
// opaque strings are masked, and stacks never appear.
function sanitizedLine(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return message
    .split("\n")[0]!
    .replace(/shell command:.*$/i, "shell command: <redacted>")
    .replace(/\b(body|stack)=.*$/i, "$1=<redacted>")
    .replace(/\b(bearer|token|key|secret|password|authorization)([=:]\s*)\S+/gi, "$1$2<redacted>")
    .replace(/[A-Za-z0-9_-]{32,}/g, "<redacted>")
    .slice(0, DETAIL_MAX_LENGTH)
}

/** Redacted, bounded description of an auth failure for opt-in (debug) diagnostics only. */
export function sanitizedAuthErrorDetail(error: unknown): string {
  const lines: string[] = []
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current !== undefined && current !== null && !seen.has(current) && lines.length < 4) {
    seen.add(current)
    lines.push(sanitizedLine(current))
    current = current instanceof Error ? current.cause : undefined
  }
  return lines.join(" <- ")
}
