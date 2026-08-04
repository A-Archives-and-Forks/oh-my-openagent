import { describe, expect, test } from "bun:test"
import { getModelCapabilities } from "./model-capabilities"
import type { ModelMetadata, ProviderCache } from "./provider-cache"

// The connected-providers adapter matches cache entries by exact id
// (`entry === modelID` / `entry.id === modelID`), so a reasoning-suffixed request
// never finds the bare model the provider actually advertised. That left
// supportsTemperature undefined, and family detection then decided the answer even
// though the provider had stated it explicitly.
function bareModelOnlyCache(bareModelID: string, metadata: ModelMetadata): ProviderCache {
  return {
    readConnectedProvidersCache: () => null,
    findProviderModelMetadata: (_providerID: string, modelID: string) =>
      modelID === bareModelID ? metadata : undefined,
  }
}

describe("getModelCapabilities provider lookup for suffixed model ids", () => {
  test("#given a provider advertising the bare model #when a colon-suffixed id is requested #then the provider metadata still resolves", () => {
    // given
    const providerCache = bareModelOnlyCache("o3", { id: "o3", temperature: true })

    // when
    const capabilities = getModelCapabilities({ providerID: "openai", modelID: "o3:high", providerCache })

    // then
    expect(capabilities.supportsTemperature).toBe(true)
    expect(capabilities.diagnostics.supportsTemperature.source).toBe("runtime")
  })

  test("#given a provider advertising the bare model #when a parenthesized or spaced suffix is requested #then the provider metadata still resolves", () => {
    // given
    const providerCache = bareModelOnlyCache("o3", { id: "o3", temperature: true })

    // when
    const parenthesized = getModelCapabilities({ providerID: "openai", modelID: "o3(high)", providerCache })
    const spaced = getModelCapabilities({ providerID: "openai", modelID: "o3 high", providerCache })

    // then
    expect(parenthesized.supportsTemperature).toBe(true)
    expect(spaced.supportsTemperature).toBe(true)
  })

  test("#given an exact suffixed entry in the cache #when it is requested #then the exact entry wins over the bare model", () => {
    // given: both forms exist and disagree, so precedence has to be observable
    const providerCache: ProviderCache = {
      readConnectedProvidersCache: () => null,
      findProviderModelMetadata: (_providerID: string, modelID: string) =>
        modelID === "o3:high"
          ? ({ id: "o3:high", temperature: false } as ModelMetadata)
          : modelID === "o3"
            ? ({ id: "o3", temperature: true } as ModelMetadata)
            : undefined,
    }

    // when
    const capabilities = getModelCapabilities({ providerID: "openai", modelID: "o3:high", providerCache })

    // then
    expect(capabilities.supportsTemperature).toBe(false)
  })

  test("#given no matching entry in either form #when capabilities are read #then temperature stays unresolved", () => {
    // given
    const providerCache = bareModelOnlyCache("gpt-4o", { id: "gpt-4o", temperature: true })

    // when
    const capabilities = getModelCapabilities({ providerID: "openai", modelID: "o3:high", providerCache })

    // then
    expect(capabilities.supportsTemperature).toBeUndefined()
  })
})
