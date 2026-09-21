import { existsSync, lstatSync, readFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { dirname, join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { canonicalAgentDir, runtimeHome } from "./agent-dir.js"
import { parseJsoncLite } from "./jsonc-lite.js"
import { assertNativeMcpConfig, assertNativeModelsConfig, nativeModelsDiagnostics, mergeOmoConfig, resolveProviderAlias, selectUserOmoConfigPath, validateOmoConfig } from "./migration-runtime.js"
import { applyMigrationPlan } from "./migration-transaction.js"
import { collectOmoAdditions, KEYBIND_MAP, normalizeKeybinding, normalizePermission, translateProvider } from "./migration-translators.js"
import { readOpencodeConfigDir, translateMcpServer } from "./setup-content.js"
import { UnsupportedConfigValue } from "./config-values.js"
import { readOpencodeConfigFiles } from "./opencode-config.js"
import { canResolveExistingModel } from "./migration-model-resolution.js"

const MIGRATION_VERSION = 2
const HANDLED_CONFIG_KEYS = new Set(["$schema", "model", "permission", "provider", "mcp", "agent", "agents"])

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

export async function planMigration(options) {
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
  const configEntry = readOpencodeConfigFiles(configDir)
  const config = configEntry.value ?? {}
  for (const path of configEntry.paths) sourcePaths.add(path)

  const settingsTarget = target(join(agentDir, "settings.json"))
  const settings = { ...settingsTarget.value }
  let settingsTouched = false
  if (isRecord(config)) {
    if (config.permission !== undefined && settings.permission === undefined) {
      settings.permission = normalizePermission(config.permission)
      settingsTouched = true
    }
    for (const key of Object.keys(config)) {
      if (!HANDLED_CONFIG_KEYS.has(key)) warnings.push(`settings.${key} (unsupported; manual review required)`)
    }
    items.settings = true
  }
  const modelsTarget = target(join(agentDir, "models.json"))
  const existingModels = existsSync(modelsTarget.path) ? modelsTarget.value : { providers: {} }
  assertNativeModelsConfig(existingModels)
  const providers = { ...existingModels.providers }
  let modelsTouched = false
  if (isRecord(config.provider)) {
    for (const [id, provider] of Object.entries(config.provider)) {
      const destinationId = resolveProviderAlias(id)
      const translated = translateProvider(id, provider)
      for (const key of translated.unsupported ?? []) warnings.push(`models.${id}.${key} (unsupported; manual review required)`)
      if (Object.hasOwn(providers, destinationId)) {
        if (translated.provider !== undefined && !isDeepStrictEqual(providers[destinationId], translated.provider)) {
          warnings.push(`models.${destinationId} (existing destination provider preserved; differing source ${id} skipped; manual review required)`)
        }
        continue
      }
      if (translated.provider !== undefined) {
        const diagnostics = nativeModelsDiagnostics({ providers: { [destinationId]: translated.provider } })
        if (diagnostics.length > 0) {
          warnings.push(...diagnostics.map((path) => `models${path} (unsupported translated value; manual review required)`))
          continue
        }
        providers[destinationId] = translated.provider
        modelsTouched = true
      } else warnings.push(`models.${id} (unsupported provider API, baseURL or config expression; manual review required)`)
    }
    items.models = true
  }
  const modelsNext = modelsTouched ? { ...existingModels, providers } : existingModels
  assertNativeModelsConfig(modelsNext)
  appendWrite(writes, modelsTarget.path, modelsNext, existingModels)
  if (typeof config.model === "string" && config.model.includes("/")) {
    const [rawProvider, ...modelParts] = config.model.split("/")
    const model = modelParts.join("/")
    if (!rawProvider || !model) {
      warnings.push("settings.model (unsupported model reference; manual review required)")
    } else if (settings.defaultProvider === undefined && settings.defaultModel === undefined) {
      const provider = resolveProviderAlias(rawProvider)
      const resolvable = !existingModels.disabledProviders?.includes(provider)
        && (!Object.hasOwn(existingModels.providers, provider) || await canResolveExistingModel(modelsTarget.path, provider, model))
      if (resolvable) {
        settings.defaultProvider = provider
        settings.defaultModel = model
        settingsTouched = true
      } else warnings.push("settings.default model (unavailable in preserved destination catalog; manual review required)")
    } else if (settings.defaultProvider === undefined || settings.defaultModel === undefined) {
      warnings.push("settings.default model (preserved existing partial provider/model pair)")
    }
  } else if (config.model !== undefined) warnings.push("settings.model (unsupported model reference; manual review required)")
  appendWrite(writes, settingsTarget.path, settings, settingsTarget.value)
  report.push(settingsTouched ? "settings: migrated" : isCurrentState && items.settings ? "settings: already migrated" : "settings: nothing to migrate")
  report.push(modelsTouched ? "models: migrated" : isCurrentState && items.models ? "models: already migrated" : "models: nothing to migrate")

  const mcpTarget = target(join(agentDir, "mcp.json"))
  assertNativeMcpConfig(mcpTarget.value)
  const servers = { ...(isRecord(mcpTarget.value.mcpServers) ? mcpTarget.value.mcpServers : {}) }
  let mcpTouched = false
  if (isRecord(config.mcp)) {
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
  assertNativeMcpConfig(mcpNext)
  appendWrite(writes, mcpTarget.path, mcpNext, mcpTarget.value)
  report.push(mcpTouched ? "mcp: migrated" : isCurrentState && items.mcp ? "mcp: already migrated" : "mcp: nothing to migrate")

  const tuiEntry = readOpencodeConfigFiles(configDir, ["tui.json", "tui.jsonc"])
  for (const path of tuiEntry.paths) sourcePaths.add(path)
  for (const key of Object.keys(tuiEntry.value ?? {})) {
    if (key !== "$schema" && key !== "keybinds") warnings.push(`keybindings.${key} (unsupported TUI setting; manual review required)`)
  }
  const keybindingsTarget = target(join(agentDir, "keybindings.json"))
  const keybindings = { ...keybindingsTarget.value }
  let keybindingsTouched = false
  if (isRecord(tuiEntry?.value?.keybinds)) {
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
    report.push("omo-config: recovered the user omo.json masked by a prior migration")
    sourcePaths.add(maskedJsonPath)
  }
  if (!isCurrentState && legacyMaskPath !== omoPath && existsSync(legacyMaskPath)) {
    const legacyMask = readJsonOrJsonc(legacyMaskPath)
    if (legacyMask !== undefined) {
      existingOmo = mergeOmoConfig(existingOmo, legacyMask).value
      report.push("omo-config: recovered a prior migration config from the engine directory")
      sourcePaths.add(legacyMaskPath)
    }
  }
  if (!isCurrentState && isRecord(state.items) && Object.hasOwn(existingOmo, "codegraph")) {
    existingOmo = { ...existingOmo }
    delete existingOmo.codegraph
    report.push("omo-config.codegraph: removed unsupported prior output; preserved in backup")
  }
  const collected = collectOmoAdditions(config, configDir, warnings, readFirstExisting)
  const { additions } = collected
  for (const path of collected.sourcePaths) sourcePaths.add(path)
  const agentScopes = [existingOmo, ...Object.values(isRecord(existingOmo.profiles) ? existingOmo.profiles : {})]
  for (const name of collected.restrictedAgents) {
    if (agentScopes.some((scope) => scope?.agents?.[name]?.disable === false || scope?.["[senpi]"]?.agents?.[name]?.disable === false)) {
      delete additions.agents[name]
      warnings.push(`agents.${name} (restricted source skipped; existing enabled agent preserved; manual review required)`)
    } else warnings.push(`agents.${name} (disabled because its OpenCode restrictions cannot be represented)`)
  }
  if (isRecord(additions.agents) && Object.keys(additions.agents).length === 0) delete additions.agents
  const merged = mergeOmoConfig(existingOmo, additions)
  warnings.push(...merged.diagnostics.map((entry) => `omo-config.${entry}`))
  const validation = validateOmoConfig(merged.value)
  if (validation.value === undefined) throw new Error(`Migration generated invalid omo config: ${validation.diagnostics.join(", ")}`)
  appendWrite(writes, omoTarget.path, validation.value, omoTarget.value)
  items.omo = true
  report.push(Object.keys(additions).length > 0 ? "omo-config: migrated" : "omo-config: nothing to migrate")

  const backupDir = join(agentDir, `migration-backup-${timestamp()}-${randomUUID()}`)
  const reportPath = join(agentDir, "opencode-migration-report.json")
  const previousReport = readJsonOrJsonc(reportPath) ?? {}
  // No-op reruns retain the last action rows, but always refresh unresolved
  // warnings. Volatile backup paths and "already" wording do not force a write.
  const durableRows = writes.length === 0 && Array.isArray(previousReport.report) ? previousReport.report : report
  const semanticReport = { version: MIGRATION_VERSION, report: durableRows, warnings: [...new Set(warnings)].sort() }
  const previousSemantic = { version: previousReport.version, report: previousReport.report, warnings: previousReport.warnings }
  if (JSON.stringify(semanticReport) !== JSON.stringify(previousSemantic)) {
    writes.push({ path: reportPath, value: { ...semanticReport, backupDirectory: backupDir } })
  }
  appendWrite(writes, statePath, { version: MIGRATION_VERSION, items }, state)
  return { backupDir, report, sourcePaths: [...sourcePaths].sort(), warnings: semanticReport.warnings, writes }
}

export { applyMigrationPlan }
