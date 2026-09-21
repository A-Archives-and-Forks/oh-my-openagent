import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { canonicalAgentDir, runtimeHome } from "./agent-dir.js"
import { parseJsoncLite } from "./jsonc-lite.js"
import { readOpencodeConfigDir, readOpencodeGlobalConfig, translateMcpServer } from "./setup-content.js"

const SETTINGS_DROPPED_KEYS = ["autoupdate", "share", "snapshot", "watcher", "formatter", "lsp", "server", "small_model"]
const OMO_SHARED_KEYS = ["categories", "agents", "task", "teams", "codegraph"]
const OMO_META_KEYS = new Set(["$schema", "_migrations", "legacy_migrations"])
const NPM_TO_API = {
  "@ai-sdk/openai-compatible": "openai-completions",
  "@ai-sdk/anthropic": "anthropic-messages",
  "@ai-sdk/google": "google-generative-ai",
}
const KEYBIND_MAP = {
  session_new: "app.session.new",
  session_list: "app.session.resume",
  model_list: "app.model.select",
  model_cycle_recent: "app.model.cycleForward",
  model_cycle_recent_reverse: "app.model.cycleBackward",
  app_exit: "app.exit",
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "")
}

function readJsonOrJsonc(path) {
  if (!existsSync(path)) return undefined
  return parseJsoncLite(readFileSync(path, "utf8"))
}

function readFirstExisting(dir, names) {
  for (const name of names) {
    const path = join(dir, name)
    if (existsSync(path)) return { path, value: readJsonOrJsonc(path) }
  }
  return undefined
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.tmp-${process.pid}`
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: "utf8" })
    renameSync(temporary, path)
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}

function parseAgentMarkdown(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!match) return { frontmatter: {}, body: text.trim() }
  const frontmatter = {}
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
    if (kv) frontmatter[kv[1]] = kv[2].trim()
  }
  return { frontmatter, body: match[2].trim() }
}

export function translateProvider(id, provider) {
  if (provider === null || typeof provider !== "object") return { needsReview: id }
  const baseUrl = provider.options?.baseURL
  if (typeof baseUrl !== "string") return { needsReview: id }
  const api = NPM_TO_API[provider.npm]
  const models = provider.models && typeof provider.models === "object"
    ? Object.entries(provider.models).map(([modelId, model]) => {
      const entry = { id: modelId, name: model?.name ?? modelId }
      if (typeof model?.limit?.context === "number") entry.contextWindow = model.limit.context
      if (typeof model?.limit?.output === "number") entry.maxTokens = model.limit.output
      return entry
    })
    : []
  const out = { baseUrl, models }
  if (api) out.api = api
  if (typeof provider.options?.apiKey === "string") out.apiKey = provider.options.apiKey
  return { provider: out, apiMissing: api === undefined }
}

export function runMigrate(args = process.argv.slice(2), options = {}) {
  const home = options.home ?? runtimeHome(options.env ?? process.env)
  const env = options.env ?? process.env
  const agentDir = canonicalAgentDir(env, home)
  const omoRoot = dirname(agentDir)
  const configDir = readOpencodeConfigDir(home, env)
  const dryRun = args.includes("--dry-run")
  const out = (line) => process.stdout.write(`${line}\n`)

  const statePath = join(agentDir, "opencode-migration-state.json")
  const state = readJsonOrJsonc(statePath) ?? { items: {} }
  const report = []
  const dropped = []
  let backupDir = null
  const backup = (sourcePath) => {
    if (dryRun) return
    backupDir ??= join(agentDir, `migration-backup-${timestamp()}`)
    mkdirSync(backupDir, { recursive: true })
    copyFileSync(sourcePath, join(backupDir, sourcePath.split("/").pop()))
  }
  const done = (item) => state.items[item] === true
  const mark = (item) => {
    state.items[item] = true
  }

  const configEntry = readFirstExisting(configDir, ["opencode.json", "opencode.jsonc"])
  const config = configEntry?.value

  if (done("settings")) {
    report.push("settings: already migrated")
  } else if (config && typeof config === "object") {
    const targetPath = join(agentDir, "settings.json")
    const existing = readJsonOrJsonc(targetPath) ?? {}
    const next = { ...existing }
    let touched = false
    if (typeof config.model === "string" && config.model.includes("/")) {
      const slash = config.model.indexOf("/")
      if (next.defaultProvider === undefined) { next.defaultProvider = config.model.slice(0, slash); touched = true }
      if (next.defaultModel === undefined) { next.defaultModel = config.model.slice(slash + 1); touched = true }
    }
    if (config.permission && typeof config.permission === "object" && next.permission === undefined) {
      next.permission = config.permission
      touched = true
    }
    for (const key of SETTINGS_DROPPED_KEYS) {
      if (config[key] !== undefined) dropped.push(`settings.${key}`)
    }
    if (touched) {
      backup(configEntry.path)
      if (existsSync(targetPath)) backup(targetPath)
      if (!dryRun) writeJsonAtomic(targetPath, next)
      report.push("settings: migrated")
    } else {
      report.push("settings: nothing to migrate")
    }
    mark("settings")
  } else {
    report.push("settings: skipped (no opencode config)")
  }

  if (done("models")) {
    report.push("models: already migrated")
  } else if (config?.provider && typeof config.provider === "object") {
    const targetPath = join(agentDir, "models.json")
    const existing = readJsonOrJsonc(targetPath) ?? {}
    const providers = { ...(existing.providers ?? {}) }
    let touched = false
    for (const [id, provider] of Object.entries(config.provider)) {
      if (Object.hasOwn(providers, id)) continue
      const translated = translateProvider(id, provider)
      if (translated.provider) {
        providers[id] = translated.provider
        touched = true
        if (translated.apiMissing) dropped.push(`models.${id}.api (npm package has no senpi api mapping; set it manually)`)
      } else {
        dropped.push(`models.${id} (no baseURL; translate by hand)`)
      }
    }
    if (touched) {
      backup(configEntry.path)
      if (existsSync(targetPath)) backup(targetPath)
      if (!dryRun) writeJsonAtomic(targetPath, { ...existing, providers })
      report.push("models: migrated")
    } else {
      report.push("models: nothing to migrate")
    }
    mark("models")
  } else {
    report.push("models: skipped (no custom providers)")
  }

  if (done("mcp")) {
    report.push("mcp: already migrated")
  } else if (config?.mcp && typeof config.mcp === "object") {
    const targetPath = join(agentDir, "mcp.json")
    const existing = readJsonOrJsonc(targetPath) ?? {}
    const servers = { ...(existing.mcpServers ?? {}) }
    let touched = false
    for (const [name, server] of Object.entries(config.mcp)) {
      if (Object.hasOwn(servers, name)) continue
      const translated = translateMcpServer(server)
      if (translated === undefined) {
        dropped.push(`mcp.${name} (unknown server shape)`)
        continue
      }
      servers[name] = translated
      touched = true
    }
    if (touched) {
      backup(configEntry.path)
      if (existsSync(targetPath)) backup(targetPath)
      if (!dryRun) writeJsonAtomic(targetPath, { ...existing, mcpServers: servers })
      report.push("mcp: migrated")
    } else {
      report.push("mcp: nothing to migrate")
    }
    mark("mcp")
  } else {
    report.push("mcp: skipped (no mcp block)")
  }

  const tuiEntry = readFirstExisting(configDir, ["tui.json", "tui.jsonc"])
  if (done("keybindings")) {
    report.push("keybindings: already migrated")
  } else if (tuiEntry?.value?.keybinds && typeof tuiEntry.value.keybinds === "object") {
    const targetPath = join(agentDir, "keybindings.json")
    const existing = readJsonOrJsonc(targetPath) ?? {}
    const next = { ...existing }
    const unmatched = []
    let touched = false
    for (const [id, keys] of Object.entries(tuiEntry.value.keybinds)) {
      const target = KEYBIND_MAP[id]
      if (target === undefined) {
        unmatched.push(id)
        continue
      }
      if (Object.hasOwn(next, target)) continue
      next[target] = keys
      touched = true
    }
    if (touched) {
      backup(tuiEntry.path)
      if (existsSync(targetPath)) backup(targetPath)
      if (!dryRun) writeJsonAtomic(targetPath, next)
    }
    report.push(touched ? "keybindings: migrated" : "keybindings: nothing to migrate")
    if (unmatched.length > 0) report.push(`keybinds-unmatched: ${unmatched.sort().join(", ")}`)
    mark("keybindings")
  } else {
    report.push("keybindings: skipped (no tui.json keybinds)")
  }

  const omoTargetPath = join(omoRoot, "omo.jsonc")
  const omoExisting = readJsonOrJsonc(omoTargetPath) ?? {}
  const omoNext = { ...omoExisting }
  let omoTouched = false

  if (done("agents")) {
    report.push("agents: already migrated")
  } else {
    const agents = { ...(omoNext.agents ?? {}) }
    const dirs = ["agents", "agent"].map((name) => join(configDir, name)).filter(existsSync)
    let touched = false
    for (const dir of dirs) {
      for (const file of readdirSync(dir).filter((name) => name.endsWith(".md")).sort()) {
        const name = file.replace(/\.md$/, "")
        if (Object.hasOwn(agents, name)) continue
        const parsed = parseAgentMarkdown(readFileSync(join(dir, file), "utf8"))
        const entry = {}
        if (parsed.frontmatter.description) entry.description = parsed.frontmatter.description
        if (parsed.frontmatter.model) entry.model = parsed.frontmatter.model
        if (parsed.body) entry.prompt = parsed.body
        agents[name] = entry
        touched = true
      }
    }
    if (touched) {
      omoNext.agents = agents
      omoTouched = true
      report.push("agents: migrated")
    } else {
      report.push("agents: skipped (no agent markdown)")
    }
    mark("agents")
  }

  const omoLegacyEntry = readFirstExisting(configDir, ["oh-my-openagent.json", "oh-my-openagent.jsonc", "oh-my-opencode.json", "oh-my-opencode.jsonc"])
  if (done("omo-config")) {
    report.push("omo-config: already migrated")
  } else if (omoLegacyEntry?.value && typeof omoLegacyEntry.value === "object") {
    let touched = false
    for (const key of OMO_SHARED_KEYS) {
      const value = omoLegacyEntry.value[key]
      if (value !== undefined && omoNext[key] === undefined) {
        omoNext[key] = value
        touched = true
      }
    }
    for (const key of Object.keys(omoLegacyEntry.value)) {
      if (!OMO_SHARED_KEYS.includes(key) && !OMO_META_KEYS.has(key)) dropped.push(`omo-config.${key}`)
    }
    if (touched) {
      omoTouched = true
      report.push("omo-config: migrated")
    } else {
      report.push("omo-config: nothing to migrate")
    }
    mark("omo-config")
  } else {
    report.push("omo-config: skipped (no oh-my-openagent.json)")
  }

  if (omoTouched) {
    if (existsSync(omoTargetPath)) backup(omoTargetPath)
    if (!dryRun) writeJsonAtomic(omoTargetPath, omoNext)
  }

  if (dryRun) out("DRY RUN: no files will be written")
  for (const line of report) out(line)
  if (dropped.length > 0) out(`dropped-with-warning: ${dropped.sort().join(", ")}`)

  if (!dryRun) {
    mkdirSync(agentDir, { recursive: true, mode: 0o700 })
    writeJsonAtomic(statePath, state)
    if (backupDir && dropped.length > 0) {
      writeFileSync(join(backupDir, "migration-notes.md"), `# Dropped or needs-review items\n\n${dropped.map((item) => `- ${item}`).join("\n")}\n`)
    }
  }
}
