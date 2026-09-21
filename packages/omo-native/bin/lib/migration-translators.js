import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { escapeConfigLiteral, translateOpencodeValue, UnsupportedConfigValue } from "./config-values.js"
import { agentFromMarkdown, mergeOmoConfig, parseAgentMarkdown } from "./migration-runtime.js"

const OMO_SHARED_KEYS = ["categories", "agents", "task", "teams"]
const OMO_META_KEYS = new Set(["$schema", "_migrations", "legacy_migrations"])
const NPM_TO_API = {
  "@ai-sdk/openai-compatible": "openai-completions",
  "@ai-sdk/anthropic": "anthropic-messages",
  "@ai-sdk/google": "google-generative-ai",
}

export const KEYBIND_MAP = {
  session_new: "app.session.new",
  session_list: "app.session.resume",
  model_list: "app.model.select",
  model_cycle_recent: "app.model.cycleForward",
  model_cycle_recent_reverse: "app.model.cycleBackward",
  app_exit: "app.exit",
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export function normalizePermission(permission) {
  const actions = new Set(["allow", "ask", "deny"])
  const normalized = typeof permission === "string" ? { "*": permission } : permission
  if (!isRecord(normalized) || !Object.values(normalized).every((value) =>
    typeof value === "string" ? actions.has(value) : isRecord(value) && Object.values(value).every((action) => actions.has(action)),
  )) throw new Error("Unsupported permission rules; no migration files were written")
  return normalized
}

function translateProviderValue(value) {
  return translateOpencodeValue(escapeConfigLiteral(value))
}

function translatedEndpoint(value) {
  if (typeof value !== "string") return undefined
  if (value.trimStart().startsWith("!") || value.includes("$(")) return undefined
  try {
    return translateProviderValue(value)
  } catch (error) {
    if (error instanceof UnsupportedConfigValue) return undefined
    throw error
  }
}

export function translateProvider(id, provider) {
  if (!isRecord(provider) || !isRecord(provider.options)) return { needsReview: id }
  const baseUrl = translatedEndpoint(provider.options.baseURL)
  if (baseUrl === undefined) return { needsReview: id }
  const api = NPM_TO_API[provider.npm]
  if (api === undefined) return { needsReview: id }
  const models = isRecord(provider.models)
    ? Object.entries(provider.models).flatMap(([modelId, model]) => {
      if (!isRecord(model)) return []
      const entry = { id: modelId, name: typeof model.name === "string" ? model.name : modelId }
      if (typeof model.id === "string") entry.upstreamModelId = model.id
      if (isRecord(model.limit) && typeof model.limit.context === "number") entry.contextWindow = model.limit.context
      if (isRecord(model.limit) && typeof model.limit.output === "number") entry.maxTokens = model.limit.output
      return [entry]
    })
    : []
  const out = { baseUrl, models }
  out.api = api
  if (typeof provider.options.apiKey === "string") {
    try {
      out.apiKey = translateProviderValue(provider.options.apiKey)
    } catch (error) {
      if (error instanceof UnsupportedConfigValue) return { needsReview: id }
      throw error
    }
  }
  return { provider: out }
}

export function normalizeKeybinding(value) {
  if (value === "none") return []
  if (typeof value !== "string") return undefined
  const alternatives = value.split(",").map((entry) => entry.trim()).filter(Boolean)
  if (alternatives.some((entry) => /[<>\s]/.test(entry) || entry === "none")) return undefined
  return alternatives.length > 1 ? alternatives : alternatives[0]
}

function addAgent(agentName, parsed, agents, warnings) {
  if (Object.hasOwn(agents, agentName)) return false
  const translated = agentFromMarkdown(parsed)
  agents[agentName] = translated.entry
  if (translated.restricted) warnings.push(`agents.${agentName} (disabled because its OpenCode restrictions cannot be represented)`)
  for (const key of translated.unsupported) warnings.push(`agents.${agentName}.${key} (unsupported; manual review required)`)
  return true
}

function addInlineAgents(config, agents, warnings) {
  const source = isRecord(config.agent) ? config.agent : isRecord(config.agents) ? config.agents : {}
  let touched = false
  for (const [name, value] of Object.entries(source)) {
    if (!isRecord(value) || Object.hasOwn(agents, name)) continue
    const frontmatter = { ...value }
    const prompt = typeof frontmatter.prompt === "string" ? frontmatter.prompt : ""
    delete frontmatter.prompt
    touched = addAgent(name, { frontmatter, body: prompt }, agents, warnings) || touched
  }
  return touched
}

function collectMarkdownAgents(configDir, agents, warnings) {
  const sourcePaths = []
  for (const dir of ["agents", "agent"].map((name) => join(configDir, name)).filter(existsSync)) {
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".md")).sort()) {
      const name = file.replace(/\.md$/, "")
      if (Object.hasOwn(agents, name)) continue
      const path = join(dir, file)
      const parsed = parseAgentMarkdown(readFileSync(path, "utf8"))
      addAgent(name, parsed, agents, warnings)
      sourcePaths.push(path)
    }
  }
  return sourcePaths
}

export function collectOmoAdditions(config, configDir, warnings, readFirstExisting) {
  const additions = {}
  const agents = {}
  const sourcePaths = collectMarkdownAgents(configDir, agents, warnings)
  addInlineAgents(config, agents, warnings)
  if (Object.keys(agents).length > 0) additions.agents = agents
  const legacy = readFirstExisting(configDir, ["oh-my-openagent.json", "oh-my-openagent.jsonc", "oh-my-opencode.json", "oh-my-opencode.jsonc"])
  if (isRecord(legacy?.value)) {
    for (const key of OMO_SHARED_KEYS) {
      if (legacy.value[key] === undefined) continue
      additions[key] = isRecord(additions[key]) && isRecord(legacy.value[key])
        ? mergeOmoConfig(additions[key], legacy.value[key]).value
        : legacy.value[key]
    }
    if (legacy.value.codegraph !== undefined) warnings.push("omo-config.codegraph (unsupported by omo.json; manual review required)")
    for (const key of Object.keys(legacy.value)) {
      if (!OMO_SHARED_KEYS.includes(key) && key !== "codegraph" && !OMO_META_KEYS.has(key)) {
        warnings.push(`omo-config.${key} (unsupported by omo.json; manual review required)`)
      }
    }
  }
  if (legacy !== undefined) sourcePaths.push(legacy.path)
  return { additions, sourcePaths }
}
