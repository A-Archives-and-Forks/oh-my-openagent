import type { ComponentContext, OmoSenpiComponent, SenpiExtensionAPI } from "../../extension/types"
import { loadSenpiOmoConfig } from "../config-resolution"
import { DEFAULT_MODEL_PROFILE_ID } from "./builtin-profiles"
import { resolveModelProfile, type ModelProfileResolution, type ModelProfileSummary } from "./resolve"

/**
 * Applies the active `model_profile` to the MAIN session model at session start.
 *
 * Session-scoped by construction: the apply path is the session-only model setter (senpi
 * `agent-session.ts` `persistDefault: false`), never the persisting one, which runs
 * `setDefaultModelAndProvider()` -> `settings.json` and would turn the profile into the very pin
 * that disables it on the next start. The component never
 * reads `settings.json` either - senpi's own `recommended-models` builtin and `/model` rewrite
 * `defaultProvider`/`defaultModel` on the same event, so those keys mean "last used", not "pinned".
 * The pin lives in `model_profile` itself as a literal `provider/model`.
 *
 * A rung counts only when its provider's request auth resolves: stored credentials that no longer
 * refresh would otherwise pin a model whose first turn cannot start, so that provider is dropped and
 * the walk continues.
 *
 * In-tier fallback is start-time only. Mid-session failures follow senpi's `retry.fallbackChains`
 * (keyed by model family); wiring those to the tier is a named follow-up, and the applied notice
 * says so.
 */

export const MODEL_PROFILE_APPLIED_TYPE = "omo-model-profile:applied"
export const MODEL_PROFILE_UNAVAILABLE_TYPE = "omo-model-profile:unavailable"
export const MODEL_PROFILE_UNKNOWN_TYPE = "omo-model-profile:unknown"

const MID_SESSION_NOTE = "mid-session fallback follows senpi's retry chains"

export interface ModelProfileComponentOptions {
  readonly loadConfig?: typeof loadSenpiOmoConfig
}

type SessionModelApi = {
  setSessionModel(model: unknown): Promise<boolean> | Promise<unknown> | boolean | void
  setSessionThinkingLevel?(level: string): void
}

type SessionRegistry = {
  getAvailable(): readonly unknown[]
  find(provider: string, modelId: string): unknown
  getApiKeyAndHeaders?(model: unknown): Promise<unknown>
}

type AuthFailure = { readonly provider: string; readonly model: string; readonly error: string }

// Mirrors senpi-task's `asSenpiThinkingLevel` (packages/senpi-task/src/senpi/thinking-level.ts),
// which that package does not export publicly: omo.json spells the disabled level "none" where
// senpi spells it "off", "auto" and unknown tokens leave the session default alone.
const SENPI_THINKING_LEVELS: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]

function asSenpiThinkingLevel(reasoning: string | undefined): string | undefined {
  if (reasoning === undefined) return undefined
  const normalized = reasoning === "none" ? "off" : reasoning
  return SENPI_THINKING_LEVELS.includes(normalized) ? normalized : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function sessionModelApi(pi: SenpiExtensionAPI): SessionModelApi | undefined {
  const candidate: unknown = pi
  if (!isRecord(candidate) || typeof candidate["setSessionModel"] !== "function") return undefined
  return candidate as unknown as SessionModelApi
}

// senpi's ExtensionContext.modelRegistry satisfies this structurally; untyped hosts yield undefined
// and the component stays silent rather than guessing a provider.
function extractRegistry(eventCtx: unknown): SessionRegistry | undefined {
  if (!isRecord(eventCtx)) return undefined
  const registry = eventCtx["modelRegistry"]
  if (!isRecord(registry)) return undefined
  if (typeof registry["getAvailable"] !== "function" || typeof registry["find"] !== "function") return undefined
  return registry as unknown as SessionRegistry
}

function extractSessionId(eventCtx: unknown): string | undefined {
  if (!isRecord(eventCtx)) return undefined
  const manager = eventCtx["sessionManager"]
  if (!isRecord(manager) || typeof manager["getSessionId"] !== "function") return undefined
  const id: unknown = Reflect.apply(manager["getSessionId"], manager, [])
  return typeof id === "string" ? id : undefined
}

// Only a fresh session may receive the profile: a resume/fork carries its own model history, a
// reload keeps the running session, and a `--model` flag or scoped model is explicit user state.
// A session_start without any provenance is treated as explicit too: senpi omits the field on a
// `--model` run, and silently overriding an unknown origin would clobber the user's choice.
function isFreshSessionWithoutExplicitModel(payload: unknown): boolean {
  if (!isRecord(payload)) return false
  const reason = payload["reason"]
  if (reason !== "startup" && reason !== "new") return false
  const provenance = payload["initialModelProvenance"]
  if (typeof provenance !== "string") return false
  return provenance !== "cli" && provenance !== "scoped"
}

// Lanes have no TUI surface yet: the terminal shows neither the lane nor its reasoning, so an
// interactive TUI session keeps the model the user started with. The desktop (rpc) and headless
// runs still apply the profile.
function isTuiSession(eventCtx: unknown): boolean {
  return isRecord(eventCtx) && eventCtx["mode"] === "tui"
}

function extractCwd(pi: SenpiExtensionAPI, eventCtx: unknown): string {
  if (pi.cwd !== undefined) return pi.cwd
  if (isRecord(eventCtx) && typeof eventCtx["cwd"] === "string") return eventCtx["cwd"]
  return process.cwd()
}

function availableSelectors(registry: SessionRegistry): string[] {
  const selectors: string[] = []
  for (const model of registry.getAvailable()) {
    if (!isRecord(model)) continue
    const provider = model["provider"]
    const id = model["id"]
    if (typeof provider === "string" && typeof id === "string") selectors.push(`${provider}/${id}`)
  }
  return selectors
}

function providerOf(selector: string): string {
  return selector.slice(0, selector.indexOf("/"))
}

// senpi resolves request auth lazily, at the first turn, and `getAvailable()` lists every provider
// with STORED credentials - including an OAuth login whose refresh token the provider now rejects.
// This is the same resolution the first turn performs (an expired OAuth token is refreshed here), so
// a failure now is the failure that turn would hit. A host without the method keeps the plain walk.
async function requestAuthError(registry: SessionRegistry, model: unknown): Promise<string | undefined> {
  if (typeof registry.getApiKeyAndHeaders !== "function") return undefined
  const result = await registry.getApiKeyAndHeaders(model)
  if (!isRecord(result) || result["ok"] !== false) return undefined
  return typeof result["error"] === "string" ? result["error"] : "request auth did not resolve"
}

// The raw refresh error can carry a URL and a stack, so the user-facing note names only the
// providers and the command that repairs them; the logger keeps the full error.
function authFailureNote(failures: readonly AuthFailure[]): string {
  const providers = [...new Set(failures.map((failure) => failure.provider))]
  const logins = providers.map((provider) => `/login ${provider}`).join(" or ")
  return `credentials for ${providers.join(", ")} did not resolve (run ${logins})`
}

function authFailedDetails(failures: readonly AuthFailure[]): { authFailed?: { provider: string; model: string }[] } {
  return failures.length === 0 ? {} : { authFailed: failures.map(({ provider, model }) => ({ provider, model })) }
}

function profileLabel(profile: ModelProfileSummary): string {
  return profile.displayName !== profile.id ? `"${profile.id}" (${profile.displayName})` : `"${profile.id}"`
}

function noticeContent(resolution: ModelProfileResolution, authFailures: readonly AuthFailure[]): string {
  switch (resolution.kind) {
    case "resolved": {
      const model = `${resolution.provider}/${resolution.modelId}`
      const reasoning = resolution.reasoning !== undefined ? ` ${resolution.reasoning}` : ""
      const skipped = resolution.skipped.length > 0 ? ` (skipped: ${resolution.skipped.join(", ")})` : ""
      const auth = authFailures.length > 0 ? `; ${authFailureNote(authFailures)}` : ""
      return `OmO Native: model profile ${profileLabel(resolution.profile)} selected ${model}${reasoning}${skipped}${auth}; ${MID_SESSION_NOTE}`
    }
    case "unavailable":
      if (authFailures.length > 0) {
        return `OmO Native: model profile ${profileLabel(resolution.profile)} has no model with working credentials; ${authFailureNote(authFailures)}; keeping senpi's default model`
      }
      return `OmO Native: model profile ${profileLabel(resolution.profile)} has no available model; none of the chain is in this session's model registry (${resolution.chain.join(", ")}); keeping senpi's default model`
    case "empty":
      return `OmO Native: model profile ${profileLabel(resolution.profile)} defines no models; keeping senpi's default model`
    case "unknown":
      return `OmO Native: ${resolution.message}`
  }
}

export function createModelProfileComponent(options: ModelProfileComponentOptions = {}): OmoSenpiComponent {
  const loadConfig = options.loadConfig ?? loadSenpiOmoConfig
  return {
    name: "model-profile",
    register(pi: SenpiExtensionAPI, ctx: ComponentContext): void {
      // One apply per session id; a host that reports no id gets exactly one apply per extension
      // instance, which is the conservative reading of "never clobber twice".
      const appliedSessions = new Set<string>()
      pi.on("session_start", async (payload, eventCtx) => {
        if (isTuiSession(eventCtx) || !isFreshSessionWithoutExplicitModel(payload)) return
        const sessionId = extractSessionId(eventCtx) ?? ""
        if (appliedSessions.has(sessionId)) return
        appliedSessions.add(sessionId)

        const config = loadConfig({ cwd: extractCwd(pi, eventCtx) }).config
        const configured = config.model_profile
        const active =
          configured !== undefined && configured.trim().length > 0 ? configured : DEFAULT_MODEL_PROFILE_ID

        const registry = extractRegistry(eventCtx)
        if (registry === undefined) {
          ctx.logger.warn("omo-senpi: model profile skipped - no model registry on the session context")
          return
        }
        const api = sessionModelApi(pi)
        if (api === undefined) {
          ctx.logger.warn("omo-senpi: model profile skipped - this senpi runtime has no setSessionModel")
          return
        }

        const available = availableSelectors(registry)
        const authFailures: AuthFailure[] = []
        const resolve = () =>
          resolveModelProfile({
            profiles: config.model_profiles,
            active,
            availableModels: available.filter(
              (selector) => !authFailures.some((failure) => failure.provider === providerOf(selector)),
            ),
          })
        let resolution = resolve()
        let model: unknown
        // Each failed probe removes one provider, so the walk ends after at most one pass per provider.
        // A literal pin is the user's explicit choice and is never swapped, so it is not probed.
        while (resolution.kind === "resolved") {
          model = registry.find(resolution.provider, resolution.modelId)
          if (model === undefined || resolution.profile.source === "pin") break
          const error = await requestAuthError(registry, model)
          if (error === undefined) break
          authFailures.push({ provider: resolution.provider, model: resolution.modelId, error })
          ctx.logger.warn(
            `omo-senpi: model profile skipped ${resolution.provider}/${resolution.modelId}: request auth did not resolve: ${error}`,
          )
          resolution = resolve()
        }
        const content = noticeContent(resolution, authFailures)

        if (resolution.kind !== "resolved") {
          const customType = resolution.kind === "unknown" ? MODEL_PROFILE_UNKNOWN_TYPE : MODEL_PROFILE_UNAVAILABLE_TYPE
          const details =
            resolution.kind === "unavailable" && authFailures.length > 0
              ? { details: { profile: resolution.profile.id, ...authFailedDetails(authFailures) } }
              : {}
          pi.sendMessage({ customType, content, display: true, ...details })
          ctx.logger.warn(content)
          return
        }

        if (model === undefined) {
          const message = `OmO Native: model profile "${resolution.profile.id}" resolved ${resolution.provider}/${resolution.modelId} but the registry no longer lists it`
          pi.sendMessage({ customType: MODEL_PROFILE_UNAVAILABLE_TYPE, content: message, display: true })
          ctx.logger.warn(message)
          return
        }
        await api.setSessionModel(model)
        const thinkingLevel = asSenpiThinkingLevel(resolution.reasoning)
        if (thinkingLevel !== undefined) api.setSessionThinkingLevel?.(thinkingLevel)
        const selectedModel = `${resolution.provider}/${resolution.modelId}`
        pi.sendMessage({
          customType: MODEL_PROFILE_APPLIED_TYPE,
          content,
          display: true,
          details: {
            profile: resolution.profile.id,
            model: selectedModel,
            skipped: [...resolution.skipped],
            ...(resolution.reasoning !== undefined ? { reasoning: resolution.reasoning } : {}),
            ...authFailedDetails(authFailures),
          },
        })
        ctx.logger.info(content, { profile: resolution.profile.id, model: selectedModel })
      })
    },
  }
}
