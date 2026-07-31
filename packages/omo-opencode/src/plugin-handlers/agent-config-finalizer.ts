import {
  clearRegisteredAgentNames,
  registerAgentName,
} from "../features/claude-code-session-state";
import { getModelCapabilities, log, parseModelString } from "../shared";
import { setDefaultAgentForSort } from "../shared/agent-sort-shim";
import { resolveCompatibleModelSettings } from "../shared/model-settings-compatibility";
import { remapAgentKeysToDisplayNames } from "./agent-key-remapper";
import { reorderAgentsByPriority } from "./agent-priority-order";
import type { ApplyAgentConfigParams } from "./agent-config-types";

type DesiredAgentSettings = {
  variant?: string;
  reasoningEffort?: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  thinking?: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function providerIDFromModel(modelID: string): string {
  return modelID.includes("/") ? modelID.split("/")[0] ?? "" : "";
}

function collectDesiredSettings(agent: Record<string, unknown>): DesiredAgentSettings {
  return {
    ...(typeof agent.variant === "string" ? { variant: agent.variant } : {}),
    ...(typeof agent.reasoningEffort === "string" ? { reasoningEffort: agent.reasoningEffort } : {}),
    ...(typeof agent.temperature === "number" ? { temperature: agent.temperature } : {}),
    ...(typeof agent.topP === "number" ? { topP: agent.topP } : {}),
    ...(typeof agent.maxTokens === "number" ? { maxTokens: agent.maxTokens } : {}),
    ...(isRecord(agent.thinking) ? { thinking: agent.thinking } : {}),
  };
}

type ModelCapabilitiesResolver = typeof getModelCapabilities;

function applyCompatibleAgentSettings(
  agent: unknown,
  resolveCapabilities: ModelCapabilitiesResolver,
): unknown {
  if (!isRecord(agent) || typeof agent.model !== "string") return agent;
  const desired = collectDesiredSettings(agent);
  const parsedModel = parseModelString(agent.model);
  const providerID = parsedModel?.providerID ?? providerIDFromModel(agent.model);
  const modelID = parsedModel?.modelID ?? agent.model;
  const compatible = resolveCompatibleModelSettings({
    providerID,
    modelID,
    desired,
    capabilities: resolveCapabilities({
      providerID,
      modelID,
    }),
  });
  if (compatible.changes.length === 0) return agent;

  const next = { ...agent };
  if (desired.temperature !== undefined) {
    if (compatible.temperature === undefined) delete next.temperature;
    else next.temperature = compatible.temperature;
  }
  return next;
}

export function applyCompatibleAgentsSettings(
  agents: Record<string, unknown>,
  resolveCapabilities: ModelCapabilitiesResolver = getModelCapabilities,
): Record<string, unknown> {
  for (const name of Object.keys(agents)) {
    agents[name] = applyCompatibleAgentSettings(agents[name], resolveCapabilities);
  }
  return agents;
}

export function finalizeAgentConfig(
  params: Pick<ApplyAgentConfigParams, "config" | "pluginConfig"> & {
    configuredDefaultAgent: string | undefined;
  },
): Record<string, unknown> {
  if (params.config.agent) {
    params.config.agent = remapAgentKeysToDisplayNames(
      params.config.agent as Record<string, unknown>,
      params.pluginConfig.agents as Record<string, { displayName?: string } | undefined> | undefined,
    );
    params.config.agent = reorderAgentsByPriority(
      params.config.agent as Record<string, unknown>,
      params.pluginConfig.agent_order,
    );
    params.config.agent = applyCompatibleAgentsSettings(
      params.config.agent as Record<string, unknown>,
    );
  }

  if (params.configuredDefaultAgent) {
    setDefaultAgentForSort(
      (params.config as { default_agent?: string }).default_agent ?? params.configuredDefaultAgent,
    );
  }

  const agentResult =
    params.config.agent != null ? (params.config.agent as Record<string, unknown>) : {};
  clearRegisteredAgentNames();
  for (const name of Object.keys(agentResult)) {
    registerAgentName(name);
  }
  log("[config-handler] agents loaded", { agentKeys: Object.keys(agentResult) });
  return agentResult;
}
