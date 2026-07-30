import { afterEach, describe, expect, test } from "bun:test";
import {
  isAgentRegistered,
  registerAgentName,
  _resetForTesting as resetSessionStateForTesting,
} from "../features/claude-code-session-state";
import type { OhMyOpenCodeConfig } from "../config";
import { finalizeAgentConfig } from "./agent-config-finalizer";

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
});
