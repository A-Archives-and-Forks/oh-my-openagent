import type { HookDeps } from "./types"
import { parseModelString } from "@oh-my-opencode/model-core"
import { HOOK_NAME } from "./constants"
import { log } from "../../shared/logger"
import { createFallbackState, isModelInCooldown, stringifyRuntimeModelWithVariant } from "./fallback-state"

export function createChatMessageHandler(deps: HookDeps) {
  const { config, sessionStates, sessionLastAccess, sessionStatusRetryKeys } = deps

  function applyRuntimeModel(
    message: { model?: { providerID: string; modelID: string }; variant?: string },
    runtimeModel: string,
  ): void {
    const parsedModel = parseModelString(runtimeModel)
    if (!parsedModel) return

    message.model = {
      providerID: parsedModel.providerID,
      modelID: parsedModel.modelID,
    }
    if (parsedModel.variant) {
      message.variant = parsedModel.variant
    } else {
      delete message.variant
    }
  }

  return async (
    input: { sessionID: string; agent?: string; model?: { providerID: string; modelID: string }; variant?: string },
    output: { message: { model?: { providerID: string; modelID: string }; variant?: string }; parts?: Array<{ type: string; text?: string }> }
  ) => {
    if (!config.enabled) return

    const { sessionID } = input
    let state = sessionStates.get(sessionID)

    if (!state) return

    sessionLastAccess.set(sessionID, Date.now())

    const requestedModel = stringifyRuntimeModelWithVariant(
      input.model,
      output.message.variant ?? input.variant,
    )

    if (requestedModel && requestedModel !== state.currentModel) {
      if (state.pendingFallbackModel && state.pendingFallbackModel === requestedModel) {
        state.pendingFallbackModel = undefined
        state.pendingFallbackPromptMayHaveBeenAccepted = false
        return
      }

      log(`[${HOOK_NAME}] Detected manual model change, resetting fallback state`, {
        sessionID,
        from: state.currentModel,
        to: requestedModel,
      })
      state = createFallbackState(requestedModel)
      sessionStates.set(sessionID, state)
      sessionStatusRetryKeys.delete(sessionID)
      return
    }

    if (
      config.restore_primary_after_cooldown &&
      state.currentModel !== state.originalModel &&
      !state.pendingFallbackModel &&
      !isModelInCooldown(state.originalModel, state, config.cooldown_seconds)
    ) {
      const activeModel = state.originalModel
      log(`[${HOOK_NAME}] Restoring preferred primary model`, {
        sessionID,
        from: state.currentModel,
        to: activeModel,
      })
      sessionStates.set(sessionID, createFallbackState(activeModel))
      applyRuntimeModel(output.message, activeModel)
      return
    }

    const activeModel = state.currentModel

    if (activeModel === state.originalModel) return

    log(`[${HOOK_NAME}] Applying fallback model override`, {
      sessionID,
      from: input.model,
      to: activeModel,
    })

    if (output.message && activeModel) applyRuntimeModel(output.message, activeModel)
  }
}
