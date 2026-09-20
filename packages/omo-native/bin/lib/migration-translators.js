import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs"
import { join } from "node:path"
import { escapeConfigLiteral, translateOpencodeValue, UnsupportedConfigValue } from "./config-values.js"
import { AgentFrontmatterError, agentFromMarkdown, mergeOmoConfig, parseAgentMarkdown } from "./migration-runtime.js"

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
  if (!isRecord(provider)) return { needsReview: id, unsupported: [] }
  const options = isRecord(provider.options) ? provider.options : {}
  const unsupported = [
    ...Object.keys(provider).filter((key) => !["npm", "options", "models"].includes(key)),
    ...Object.keys(options).filter((key) => !["baseURL", "apiKey"].includes(key)).map((key) => `options.${key}`),
  ]
  const models = isRecord(provider.models)
    ? Object.entries(provider.models).flatMap(([modelId, model]) => {
      if (!isRecord(model)) return []
      unsupported.push(...Object.keys(model).filter((key) => !["id", "name", "limit"].includes(key)).map((key) => `models.${modelId}.${key}`))
      if (isRecord(model.limit)) unsupported.push(...Object.keys(model.limit).filter((key) => !["context", "output"].includes(key)).map((key) => `models.${modelId}.limit.${key}`))
      const entry = { id: modelId, name: typeof model.name === "string" ? model.name : modelId }
      if (typeof model.id === "string") entry.upstreamModelId = model.id
      if (isRecord(model.limit) && typeof model.limit.context === "number") entry.contextWindow = model.limit.context
      if (isRecord(model.limit) && typeof model.limit.output === "number") entry.maxTokens = model.limit.output
      return [entry]
    })
    : []
  const baseUrl = translatedEndpoint(options.baseURL)
  if (baseUrl === undefined) return { needsReview: id, unsupported }
  const api = NPM_TO_API[provider.npm]
  if (api === undefined) return { needsReview: id, unsupported }
  const out = { baseUrl, models }
  out.api = api
  if (typeof options.apiKey === "string") {
    try {
      out.apiKey = translateProviderValue(options.apiKey)
    } catch (error) {
      if (error instanceof UnsupportedConfigValue) return { needsReview: id, unsupported }
      throw error
    }
  }
  return { provider: out, unsupported }
}

export function normalizeKeybinding(value) {
  if (value === "none") return []
  if (typeof value !== "string") return undefined
  const alternatives = value.split(",").map((entry) => entry.trim()).filter(Boolean)
  if (alternatives.some((entry) => /[<>\s]/.test(entry) || entry === "none")) return undefined
  return alternatives.length > 1 ? alternatives : alternatives[0]
}

function addAgent(agentName, parsed, agents, warnings, restrictedAgents) {
  const translated = agentFromMarkdown(parsed)
  agents[agentName] = Object.hasOwn(agents, agentName)
    ? mergeOmoConfig(agents[agentName], translated.entry).value
    : translated.entry
  if (translated.restricted) {
    agents[agentName].disable = true
    restrictedAgents.add(agentName)
  }
  for (const key of translated.unsupported) warnings.push(`agents.${agentName}.${key} (unsupported; manual review required)`)
  return true
}

function addInlineAgents(config, agents, warnings, restrictedAgents) {
  const source = isRecord(config.agent) ? config.agent : isRecord(config.agents) ? config.agents : {}
  let touched = false
  for (const [name, value] of Object.entries(source)) {
    if (!isRecord(value)) continue
    const frontmatter = { ...value }
    const prompt = typeof frontmatter.prompt === "string" ? frontmatter.prompt : undefined
    delete frontmatter.prompt
    touched = addAgent(name, { frontmatter, body: prompt }, agents, warnings, restrictedAgents) || touched
  }
  return touched
}

function collectMarkdownAgents(configDir, agents, warnings, restrictedAgents) {
  const sourcePaths = []
  const walk = (dir, prefix, ancestors) => {
    const real = realpathSync(dir)
    if (ancestors.has(real)) {
      warnings.push(`agents.${prefix} (directory cycle; manual review required)`)
      return
    }
    const parents = new Set([...ancestors, real])
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      const path = join(dir, entry.name)
      const kind = entry.isSymbolicLink() ? statSync(path) : entry
      if (kind.isDirectory()) {
        walk(path, relative, parents)
        continue
      }
      if (!entry.name.endsWith(".md")) continue
      const name = relative.replace(/\.md$/, "")
      sourcePaths.push(path)
      if (Object.hasOwn(agents, name)) continue
      const content = readFileSync(path, "utf8")
      try {
        const parsed = parseAgentMarkdown(content)
        addAgent(name, parsed, agents, warnings, restrictedAgents)
      } catch (error) {
        if (!(error instanceof AgentFrontmatterError)) throw error
        warnings.push(`agents.${name} (malformed frontmatter; manual review required)`)
      }
    }
  }
  for (const dir of ["agents", "agent"].map((name) => join(configDir, name)).filter(existsSync)) walk(dir, "", new Set())
  return sourcePaths
}

export function collectOmoAdditions(config, configDir, warnings, readFirstExisting) {
  const additions = {}
  const agents = {}
  const restrictedAgents = new Set()
  const sourcePaths = collectMarkdownAgents(configDir, agents, warnings, restrictedAgents)
  addInlineAgents(config, agents, warnings, restrictedAgents)
  const legacy = readFirstExisting(configDir, ["oh-my-openagent.json", "oh-my-openagent.jsonc", "oh-my-opencode.json", "oh-my-opencode.jsonc"])
  if (isRecord(legacy?.value)) {
    addInlineAgents({ agent: legacy.value.agents }, agents, warnings, restrictedAgents)
    for (const key of OMO_SHARED_KEYS) {
      if (key === "agents" || legacy.value[key] === undefined) continue
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
  if (Object.keys(agents).length > 0) additions.agents = agents
  if (legacy !== undefined) sourcePaths.push(legacy.path)
  return { additions, sourcePaths, restrictedAgents }
}
