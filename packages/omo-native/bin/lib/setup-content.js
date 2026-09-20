import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { readOpencodeGlobalConfig } from "./opencode-config.js"
import { translateOpencodeValue, UnsupportedConfigValue } from "./config-values.js"
export { readOpencodeConfigDir, readOpencodeGlobalConfig } from "./opencode-config.js"

function translateMcpValue(value) {
  if (typeof value === "string") {
    // OpenCode's raw ${...} is literal, whereas Senpi interpolates it. Check
    // before converting supported {env:...} so the two syntaxes cannot mix.
    if (/\$\{[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\}/.test(value)) throw new UnsupportedConfigValue()
    const translated = translateOpencodeValue(value)
    if (translated.trimStart().startsWith("!") || translated.includes("$(")) throw new UnsupportedConfigValue()
    return translated
  }
  if (Array.isArray(value)) return value.map(translateMcpValue)
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, translateMcpValue(item)]))
  return value
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export function translateMcpServer(server) {
  if (server === null || typeof server !== "object" || Array.isArray(server)) return undefined
  if (server.type === "local") {
    const command = Array.isArray(server.command) ? server.command : []
    if (command.length === 0) return undefined
    const out = { type: "stdio", command: command[0] }
    if (command.length > 1) out.args = command.slice(1)
    if (server.environment && typeof server.environment === "object") out.env = server.environment
    if (typeof server.cwd === "string") out.cwd = server.cwd
    if (typeof server.enabled === "boolean") out.enabled = server.enabled
    if (typeof server.timeout === "number") out.startupTimeoutMs = server.timeout
    return translateMcpValue(out)
  }
  if (server.type === "remote") {
    if (typeof server.url !== "string") return undefined
    const out = { type: "http", url: server.url }
    if (server.headers && typeof server.headers === "object") out.headers = server.headers
    if (typeof server.enabled === "boolean") out.enabled = server.enabled
    if (typeof server.timeout === "number") out.requestTimeoutMs = server.timeout
    return translateMcpValue(out)
  }
  return undefined
}

function listSkillDirs(configDir) {
  const skillsDir = join(configDir, "skills")
  if (!existsSync(skillsDir)) return []
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(skillsDir, entry.name, "SKILL.md")))
    .map((entry) => entry.name)
    .sort()
}

export async function planContentImport({ configDir, agentDir }) {
  const plan = {
    mcp: { add: [], skipExisting: [], invalid: [], expectedBytes: undefined },
    skills: { add: [], skipExisting: [] },
    agentsMd: "absent",
    notices: [],
    translated: {},
  }
  const config = readOpencodeGlobalConfig(configDir)
  if (config !== undefined && config !== null && typeof config === "object") {
    const mcp = config.mcp
    if (isObject(mcp) && Object.keys(mcp).length > 0) {
      // MCP schema validation is a command-local dependency; other setup paths
      // remain usable before the source checkout's runtime bundle is built.
      const { assertNativeMcpConfig } = await import("./migration-runtime.js")
      let existingServers = {}
      let existingConfig = {}
      const targetPath = join(agentDir, "mcp.json")
      if (existsSync(targetPath)) {
        try {
          plan.mcp.expectedBytes = readFileSync(targetPath, "utf8")
          const parsed = JSON.parse(plan.mcp.expectedBytes)
          if (!isObject(parsed) || (parsed.mcpServers !== undefined && !isObject(parsed.mcpServers))) throw new SyntaxError("expected MCP object")
          existingServers = parsed.mcpServers ?? {}
          existingConfig = parsed
        } catch {
          throw new Error("Malformed mcp.json; setup did not write any files")
        }
      }
      assertNativeMcpConfig(existingConfig)
      for (const [name, server] of Object.entries(mcp)) {
        if (Object.hasOwn(existingServers, name)) {
          plan.mcp.skipExisting.push(name)
          continue
        }
        let translated
        try {
          translated = translateMcpServer(server)
        } catch (error) {
          if (!(error instanceof UnsupportedConfigValue)) throw error
        }
        if (translated === undefined) {
          plan.mcp.invalid.push(name)
          continue
        }
        plan.mcp.add.push(name)
        plan.translated[name] = translated
      }
      assertNativeMcpConfig({ ...existingConfig, mcpServers: { ...existingServers, ...plan.translated } })
      if (plan.mcp.invalid.length > 0) {
        plan.notices.push(`NOTICE opencode: mcp servers need manual review: ${plan.mcp.invalid.sort().join(", ")}`)
      }
    }
  }
  const targetSkills = join(agentDir, "skills")
  for (const name of listSkillDirs(configDir)) {
    if (existsSync(join(targetSkills, name))) plan.skills.skipExisting.push(name)
    else plan.skills.add.push(name)
  }
  const sourceAgents = join(configDir, "AGENTS.md")
  if (existsSync(sourceAgents)) {
    plan.agentsMd = existsSync(join(agentDir, "AGENTS.md")) ? "exists" : "copy"
  }
  return plan
}

export function contentPlanHasWork(plan) {
  return plan.mcp.add.length > 0 || plan.skills.add.length > 0 || plan.agentsMd === "copy"
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "")
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.tmp-${process.pid}`
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 })
    renameSync(temporary, path)
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}

export function writeContentImport(plan, { configDir, agentDir }) {
  const written = { mcp: [], skills: [], agentsMd: plan.agentsMd === "copy" ? "copied" : plan.agentsMd }
  if (plan.mcp.add.length > 0) {
    const targetPath = join(agentDir, "mcp.json")
    let current = {}
    if (existsSync(targetPath)) {
      current = JSON.parse(readFileSync(targetPath, "utf8"))
      copyFileSync(targetPath, `${targetPath}.bak-${timestamp()}`)
    }
    const servers = { ...(current.mcpServers ?? {}) }
    for (const name of plan.mcp.add) servers[name] = plan.translated[name]
    writeJsonAtomic(targetPath, { ...current, mcpServers: servers })
    written.mcp = plan.mcp.add
  }
  for (const name of plan.skills.add) {
    cpSync(join(configDir, "skills", name), join(agentDir, "skills", name), { recursive: true })
    written.skills.push(name)
  }
  if (plan.agentsMd === "copy") {
    mkdirSync(agentDir, { recursive: true, mode: 0o700 })
    copyFileSync(join(configDir, "AGENTS.md"), join(agentDir, "AGENTS.md"))
  }
  return written
}

export function printContentPlan(plan) {
  const list = (label, ids) => `${label}: ${ids.length > 0 ? ids.join(", ") : "none"}`
  process.stdout.write(`${[
    list("mcp-planned-add", plan.mcp.add),
    list("mcp-skipped-existing", plan.mcp.skipExisting),
    list("skills-planned-add", plan.skills.add),
    list("skills-skipped-existing", plan.skills.skipExisting),
    `agents-md: ${plan.agentsMd}`,
  ].join("\n")}\n`)
}

export function printContentCounts(written) {
  process.stdout.write([
    `mcp-imported: ${written.mcp.length}`,
    `skills-imported: ${written.skills.length}`,
    `agents-md: ${written.agentsMd}`,
  ].join("\n") + "\n")
}
