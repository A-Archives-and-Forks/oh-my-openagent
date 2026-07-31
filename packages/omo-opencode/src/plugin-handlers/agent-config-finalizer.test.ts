import { afterEach, describe, expect, test } from "bun:test";
import {
  isAgentRegistered,
  registerAgentName,
  _resetForTesting as resetSessionStateForTesting,
} from "../features/claude-code-session-state";
import type { OhMyOpenCodeConfig } from "../config";
import { getModelCapabilities } from "../shared";
import {
  applyCompatibleAgentsSettings,
  finalizeAgentConfig,
} from "./agent-config-finalizer";

function createPluginConfig(): OhMyOpenCodeConfig {
  return {
    sisyphus_agent: {
      planner_enabled: false,
    },
  };
}

describe("finalizeAgentConfig", () => {
  afterEach(() => {
    resetSessionStateForTesting();
  });

  test("does not throw or keep stale registrations when config.agent is absent", () => {
    // given
    registerAgentName("stale-agent");

    // when
    const result = finalizeAgentConfig({
      config: {},
      pluginConfig: createPluginConfig(),
      configuredDefaultAgent: undefined,
    });

    // then
    expect(result).toEqual({});
    expect(isAgentRegistered("stale-agent")).toBe(false);
  });

  test("removes hardcoded temperature from agents using Claude Opus 4.8", () => {
    // given
    const config = {
      agent: {
        oracle: {
          model: "anthropic/claude-opus-4-8",
          temperature: 0.1,
        },
      },
    };

    // when
    const result = finalizeAgentConfig({
      config,
      pluginConfig: createPluginConfig(),
      configuredDefaultAgent: undefined,
    });

    // then
    expect(result.oracle).toEqual({
      model: "anthropic/claude-opus-4-8",
    });
  });

  test("removes hardcoded temperature when bundled capabilities mark it unsupported", () => {
    // given
    const config = {
      agent: {
        oracle: {
          model: "openai/gpt-5.6-sol",
          temperature: 0.1,
        },
      },
    };

    // when
    const result = finalizeAgentConfig({
      config,
      pluginConfig: createPluginConfig(),
      configuredDefaultAgent: undefined,
    });

    // then
    expect(result.oracle).toEqual({
      model: "openai/gpt-5.6-sol",
    });
  });

  test("uses the bare model ID for runtime capability metadata lookup", () => {
    // given
    const agents = {
      oracle: {
        model: "custom-provider/future-model",
        temperature: 0.1,
      },
    };
    let observedInput: Parameters<typeof getModelCapabilities>[0] | undefined;

    // when
    applyCompatibleAgentsSettings(agents, (input) => {
      observedInput = input;
      return getModelCapabilities({
        ...input,
        runtimeModel: {
          id: input.modelID,
          temperature: false,
        },
      });
    });

    // then
    expect(observedInput).toEqual({
      providerID: "custom-provider",
      modelID: "future-model",
    });
    expect(agents.oracle).toEqual({
      model: "custom-provider/future-model",
    });
  });

  test("updates compatible settings without replacing the ordered agent map", () => {
    // given
    const agents = {
      "Atlas - Plan Executor": {
        model: "anthropic/claude-opus-4-8",
        temperature: 0.1,
      },
      "Sisyphus - ultraworker": {
        model: "openai/gpt-5.4",
      },
    };

    // when
    const result = applyCompatibleAgentsSettings(agents);

    // then
    expect(result).toBe(agents);
    expect(Object.keys(result)).toEqual([
      "Atlas - Plan Executor",
      "Sisyphus - ultraworker",
    ]);
    expect(result["Atlas - Plan Executor"]).toEqual({
      model: "anthropic/claude-opus-4-8",
    });
  });
});
