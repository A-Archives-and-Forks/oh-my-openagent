/**
 * Reads the OpenCode user-scope config and skill tree and converts what it finds into the shapes
 * the engine's global `mcp.json` and global skill root accept. Read-only: nothing here writes.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { parseJsonc } from "./jsonc.js"

// `interpolateString` in the engine's mcp config rejects any string value that looks like command
// substitution - one containing `$(` or starting (after leading whitespace) with `!` - and one bad
// value fails the whole file, so such a server is dropped, not copied.
function rejectedByEngine(value) {
  if (typeof value === "string") return value.trimStart().startsWith("!") || value.includes("$(")
  if (Array.isArray(value)) return value.some(rejectedByEngine)
  if (value !== null && typeof value === "object") return Object.values(value).some(rejectedByEngine)
  return false
}

// OpenCode's global config is every one of these files deep-merged in this order, later keys
// winning - not the first one found - so a server declared in opencode.jsonc is live even when an
// opencode.json sits next to it.
const GLOBAL_CONFIG_FILES = ["config.json", "opencode.json", "opencode.jsonc"]

// Every other user-scope config directory contributes only these two, on top of the global dir.
const DIRECTORY_CONFIG_FILES = ["opencode.json", "opencode.jsonc"]

/**
 * Where OpenCode itself reads user-scope config, in its merge order: the global dir's files, then
 * `$OPENCODE_CONFIG`, then `~/.opencode` and `$OPENCODE_CONFIG_DIR`. `OPENCODE_CONFIG_DIR` is one
 * more layer on top of the global dir, not a replacement for it, and every directory can hold
 * skills.
 */
export function opencodeConfigSources(home, env) {
  const globalDir = join(env.XDG_CONFIG_HOME || join(home, ".config"), "opencode")
  const directories = [globalDir, join(home, ".opencode")]
  const explicitDir = env.OPENCODE_CONFIG_DIR?.trim()
  if (explicitDir && !directories.includes(resolve(explicitDir))) directories.push(resolve(explicitDir))
  const files = GLOBAL_CONFIG_FILES.map((name) => join(globalDir, name))
  const explicitFile = env.OPENCODE_CONFIG?.trim()
  if (explicitFile) files.push(resolve(explicitFile))
  for (const directory of directories.slice(1)) files.push(...DIRECTORY_CONFIG_FILES.map((name) => join(directory, name)))
  return { files, directories }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function mergeDeep(base, overlay) {
  const merged = { ...base }
  for (const [key, value] of Object.entries(overlay)) {
    if (key === "__proto__") continue
    merged[key] = isPlainObject(merged[key]) && isPlainObject(value) ? mergeDeep(merged[key], value) : value
  }
  return merged
}

function readDeclaredServers(files, notices) {
  let declared = {}
  for (const path of files) {
    if (!existsSync(path)) continue
    let parsed
    try {
      parsed = parseJsonc(readFileSync(path, "utf8"))
    } catch (error) {
      notices.push(`WARN opencode: could not parse ${path}: ${error.message}; its mcp servers were not imported`)
      continue
    }
    if (!isPlainObject(parsed)) {
      notices.push(`WARN opencode: ${path} is not an object; its mcp servers were not imported`)
      continue
    }
    if (isPlainObject(parsed.mcp)) declared = mergeDeep(declared, parsed.mcp)
  }
  return declared
}

// OpenCode substitutes `{env:NAME}`; the engine substitutes `${NAME}`. Same intent, same value.
function convertPlaceholders(value) {
  return typeof value === "string" ? value.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, "${$1}") : value
}

function convertRecord(record) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) return undefined
  const entries = Object.entries(record).filter(([, value]) => typeof value === "string")
  return entries.length > 0 ? Object.fromEntries(entries.map(([key, value]) => [key, convertPlaceholders(value)])) : undefined
}

function disabled(entry) {
  return entry.enabled === false ? { enabled: false } : {}
}

function convertLocal(entry) {
  const command = Array.isArray(entry.command) ? entry.command.filter((part) => typeof part === "string") : []
  if (command.length === 0) return undefined
  const env = convertRecord(entry.environment)
  return {
    type: "stdio",
    command: convertPlaceholders(command[0]),
    ...(command.length > 1 ? { args: command.slice(1).map(convertPlaceholders) } : {}),
    ...(env ? { env } : {}),
    ...disabled(entry),
  }
}

function convertRemote(entry) {
  if (typeof entry.url !== "string" || entry.url.trim() === "") return undefined
  const headers = convertRecord(entry.headers)
  return {
    type: "http",
    url: convertPlaceholders(entry.url),
    ...(headers ? { headers } : {}),
    // OpenCode's `oauth: false` disables OAuth auto-detection; the engine spells that `auth: false`.
    ...(entry.oauth === false ? { auth: false } : {}),
    ...disabled(entry),
  }
}

function convertServer(name, entry, notices) {
  if (entry === null || typeof entry !== "object") return undefined
  const config = entry.type === "remote" ? convertRemote(entry) : convertLocal(entry)
  if (!config) {
    notices.push(`NOTICE opencode: mcp server ${name} has no usable command or url; not imported`)
    return undefined
  }
  if (rejectedByEngine(config)) {
    notices.push(`NOTICE opencode: mcp server ${name} uses command substitution, which omo refuses to run; not imported`)
    return undefined
  }
  return config
}

function readSkills(configDirs) {
  const skills = []
  for (const root of configDirs.flatMap((configDir) => [join(configDir, "skills"), join(configDir, "skill")])) {
    if (!existsSync(root)) continue
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      const source = join(root, entry.name)
      if (!existsSync(join(source, "SKILL.md"))) continue
      if (skills.some((skill) => skill.name === entry.name)) continue
      skills.push({ name: entry.name, source })
    }
  }
  // readdir order is filesystem-dependent; the printed plan and the import order must not be.
  return skills.sort((left, right) => left.name.localeCompare(right.name))
}

export function planOpencodeAssets(options = {}) {
  const home = options.home ?? homedir()
  const env = options.env ?? process.env
  const sources = opencodeConfigSources(home, env)
  const notices = []
  const mcpServers = []
  for (const [name, entry] of Object.entries(readDeclaredServers(sources.files, notices))) {
    const converted = convertServer(name, entry, notices)
    if (converted) mcpServers.push({ name, config: converted })
  }
  return { mcpServers, skills: readSkills(sources.directories), notices }
}
