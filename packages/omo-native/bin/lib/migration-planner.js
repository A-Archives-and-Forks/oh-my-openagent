import { existsSync, lstatSync, readFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { dirname, join } from "node:path"
import { canonicalAgentDir, runtimeHome } from "./agent-dir.js"
import { parseJsoncLite } from "./jsonc-lite.js"
import { mergeOmoConfig, resolveProviderAlias, selectUserOmoConfigPath, validateOmoConfig } from "./migration-runtime.js"
import { applyMigrationPlan } from "./migration-transaction.js"
import { collectOmoAdditions, KEYBIND_MAP, normalizeKeybinding, normalizePermission, translateProvider } from "./migration-translators.js"
import { readOpencodeConfigDir, translateMcpServer } from "./setup-content.js"
import { UnsupportedConfigValue } from "./config-values.js"

const MIGRATION_VERSION = 2
const SETTINGS_DROPPED_KEYS = ["autoupdate", "share", "snapshot", "watcher", "formatter", "lsp", "server", "small_model"]

function timestamp() {
  return new Date().toISOString().replace(/[-:.]/g, "")
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function readJsonOrJsonc(path) {
  if (!existsSync(path)) return undefined
  let parsed
  try {
    parsed = parseJsoncLite(readFileSync(path, "utf8"))
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    throw new Error(`Malformed migration config: ${path}`)
  }
  if (!isRecord(parsed)) throw new Error(`Malformed migration target: ${path}`)
  return parsed
}

function readFirstExisting(dir, names) {
  for (const name of names) {
    const path = join(dir, name)
    if (existsSync(path)) return { path, value: readJsonOrJsonc(path) }
  }
  return undefined
}

function target(path) {
  const stat = lstatSync(path, { throwIfNoEntry: false })
  if (stat && !stat.isFile()) throw new Error(`Migration target must be a regular file: ${path}`)
  return { path, value: readJsonOrJsonc(path) ?? {} }
}

function appendWrite(writes, path, next, previous) {
  if (JSON.stringify(next) !== JSON.stringify(previous)) writes.push({ path, value: next })
}

export function planMigration(options) {
  const env = options.env ?? process.env
  const home = options.home ?? runtimeHome(env)
  const agentDir = canonicalAgentDir(env, home)
  const configDir = readOpencodeConfigDir(home, env)
  const statePath = join(agentDir, "opencode-migration-state.json")
  const state = readJsonOrJsonc(statePath) ?? {}
  const isCurrentState = state.version === MIGRATION_VERSION && isRecord(state.items)
  const items = isCurrentState ? { ...state.items } : {}
  const warnings = []
  const report = []
  const writes = []
  const sourcePaths = new Set()
  const configEntry = readFirstExisting(configDir, ["opencode.json", "opencode.jsonc"])
  const config = configEntry?.value ?? {}
  if (configEntry !== undefined) sourcePaths.add(configEntry.path)

  const settingsTarget = target(join(agentDir, "settings.json"))
  const settings = { ...settingsTarget.value }
  let settingsTouched = false
  if (!items.settings && isRecord(config)) {
    if (typeof config.model === "string" && config.model.includes("/")) {
      const [rawProvider, ...modelParts] = config.model.split("/")
      const model = modelParts.join("/")
      if (settings.defaultProvider === undefined && settings.defaultModel === undefined && rawProvider && model) {
        settings.defaultProvider = resolveProviderAlias(rawProvider)
        settings.defaultModel = model
        settingsTouched = true
      } else if (settings.defaultProvider === undefined || settings.defaultModel === undefined) {
        warnings.push("settings.default model (preserved existing partial provider/model pair)")
      }
    }
    if (config.permission !== undefined && settings.permission === undefined) {
      settings.permission = normalizePermission(config.permission)
      settingsTouched = true
    }
    for (const key of SETTINGS_DROPPED_KEYS) {
      if (config[key] !== undefined) warnings.push(`settings.${key} (unsupported; manual review required)`)
    }
    items.settings = true
  }
  appendWrite(writes, settingsTarget.path, settings, settingsTarget.value)
  report.push(settingsTouched ? "settings: migrated" : isCurrentState && items.settings ? "settings: already migrated" : "settings: nothing to migrate")

  const modelsTarget = target(join(agentDir, "models.json"))
  if (modelsTarget.value.providers !== undefined && !isRecord(modelsTarget.value.providers)) throw new Error("Malformed models.json providers")
  const providers = { ...(isRecord(modelsTarget.value.providers) ? modelsTarget.value.providers : {}) }
  let modelsTouched = false
  if (!items.models && isRecord(config.provider)) {
    for (const [id, provider] of Object.entries(config.provider)) {
      if (Object.hasOwn(providers, id)) continue
      const translated = translateProvider(id, provider)
      if (translated.provider !== undefined) {
        providers[id] = translated.provider
        modelsTouched = true
      } else warnings.push(`models.${id} (unsupported provider API, baseURL or config expression; manual review required)`)
    }
    items.models = true
  }
  const modelsNext = modelsTouched ? { ...modelsTarget.value, providers } : modelsTarget.value
  appendWrite(writes, modelsTarget.path, modelsNext, modelsTarget.value)
  report.push(modelsTouched ? "models: migrated" : isCurrentState && items.models ? "models: already migrated" : "models: nothing to migrate")

  const mcpTarget = target(join(agentDir, "mcp.json"))
  if (mcpTarget.value.mcpServers !== undefined && !isRecord(mcpTarget.value.mcpServers)) throw new Error("Malformed mcp.json servers")
  const servers = { ...(isRecord(mcpTarget.value.mcpServers) ? mcpTarget.value.mcpServers : {}) }
  let mcpTouched = false
  if (!items.mcp && isRecord(config.mcp)) {
    for (const [name, server] of Object.entries(config.mcp)) {
      if (Object.hasOwn(servers, name)) continue
      try {
        const translated = translateMcpServer(server)
        if (translated === undefined) warnings.push(`mcp.${name} (unknown server shape; manual review required)`)
        else {
          servers[name] = translated
          mcpTouched = true
        }
      } catch (error) {
        if (error instanceof UnsupportedConfigValue) warnings.push(`mcp.${name} (unsupported config expression; manual review required)`)
        else throw error
      }
    }
    items.mcp = true
  }
  const mcpNext = mcpTouched ? { ...mcpTarget.value, mcpServers: servers } : mcpTarget.value
  appendWrite(writes, mcpTarget.path, mcpNext, mcpTarget.value)
  report.push(mcpTouched ? "mcp: migrated" : isCurrentState && items.mcp ? "mcp: already migrated" : "mcp: nothing to migrate")

  const tuiEntry = readFirstExisting(configDir, ["tui.json", "tui.jsonc"])
  if (tuiEntry !== undefined) sourcePaths.add(tuiEntry.path)
  const keybindingsTarget = target(join(agentDir, "keybindings.json"))
  const keybindings = { ...keybindingsTarget.value }
  let keybindingsTouched = false
  if (!items.keybindings && isRecord(tuiEntry?.value?.keybinds)) {
    for (const [id, keys] of Object.entries(tuiEntry.value.keybinds)) {
      const mapped = KEYBIND_MAP[id]
      const normalized = normalizeKeybinding(keys)
      if (mapped === undefined || normalized === undefined) warnings.push(`keybindings.${id} (unsupported; manual review required)`)
      else if (!Object.hasOwn(keybindings, mapped)) {
        keybindings[mapped] = normalized
        keybindingsTouched = true
      }
    }
    items.keybindings = true
  }
  const keybindingsNext = keybindingsTouched ? keybindings : keybindingsTarget.value
  appendWrite(writes, keybindingsTarget.path, keybindingsNext, keybindingsTarget.value)
  report.push(keybindingsTouched ? "keybindings: migrated" : isCurrentState && items.keybindings ? "keybindings: already migrated" : "keybindings: nothing to migrate")

  const omoPath = selectUserOmoConfigPath(home)
  const omoTarget = target(omoPath)
  const legacyMaskPath = join(dirname(agentDir), "omo.jsonc")
  let existingOmo = omoTarget.value
  const maskedJsonPath = join(home, ".omo", "omo.json")
  if (!isCurrentState && isRecord(state.items) && omoPath.endsWith("omo.jsonc") && existsSync(maskedJsonPath)) {
    existingOmo = mergeOmoConfig(existingOmo, readJsonOrJsonc(maskedJsonPath)).value
    warnings.push("omo-config (recovered the user omo.json masked by a prior migration)")
    sourcePaths.add(maskedJsonPath)
  }
  if (!isCurrentState && legacyMaskPath !== omoPath && existsSync(legacyMaskPath)) {
    const legacyMask = readJsonOrJsonc(legacyMaskPath)
    if (legacyMask !== undefined) {
      existingOmo = mergeOmoConfig(existingOmo, legacyMask).value
      warnings.push("omo-config (recovered a prior migration config from the engine directory)")
      sourcePaths.add(legacyMaskPath)
    }
  }
  if (!isCurrentState && isRecord(state.items) && Object.hasOwn(existingOmo, "codegraph")) {
    existingOmo = { ...existingOmo }
    delete existingOmo.codegraph
    warnings.push("omo-config.codegraph (removed unsupported output from a prior migration; preserved in backup)")
  }
  const collected = collectOmoAdditions(config, configDir, warnings, readFirstExisting)
  const { additions } = collected
  for (const path of collected.sourcePaths) sourcePaths.add(path)
  const merged = mergeOmoConfig(existingOmo, additions)
  warnings.push(...merged.diagnostics.map((entry) => `omo-config.${entry}`))
  const validation = validateOmoConfig(merged.value)
  if (validation.value === undefined) throw new Error(`Migration generated invalid omo config: ${validation.diagnostics.join(", ")}`)
  appendWrite(writes, omoTarget.path, validation.value, omoTarget.value)
  items.omo = true
  report.push(Object.keys(additions).length > 0 ? "omo-config: migrated" : "omo-config: nothing to migrate")

  const backupDir = join(agentDir, `migration-backup-${timestamp()}-${randomUUID()}`)
  const reportPath = join(agentDir, "opencode-migration-report.json")
  const reportValue = { version: MIGRATION_VERSION, report, warnings: [...new Set(warnings)].sort(), backupDirectory: backupDir }
  if (writes.length > 0 || !existsSync(reportPath)) appendWrite(writes, reportPath, reportValue, readJsonOrJsonc(reportPath) ?? {})
  appendWrite(writes, statePath, { version: MIGRATION_VERSION, items }, state)
  return { backupDir, report, sourcePaths: [...sourcePaths].sort(), warnings: reportValue.warnings, writes }
}

export { applyMigrationPlan }
