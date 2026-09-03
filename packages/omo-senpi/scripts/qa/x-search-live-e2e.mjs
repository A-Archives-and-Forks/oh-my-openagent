#!/usr/bin/env node
import { randomBytes } from "node:crypto"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { createSandbox, seedSandbox, snapshotDirectory, changedSnapshotPaths, credentialDigest } from "./drive.mjs"

const scriptDir = dirname(fileURLToPath(import.meta.url))
const mockProviderEntry = join(scriptDir, "task-e2e-mock-provider.ts")
const realAgentDir = join(homedir(), ".senpi", "agent")
const sourceAuth = join(homedir(), ".omo", "agent", "auth.json")
const scenarios = new Set(["negative", "positive", "reload", "child", "librarian", "explore"])
const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
const NEGATIVE_CONTROL_QUERY = "analyze the data"

export function createScrubbedEnvironment(input = process.env) {
  const env = {}
  const scrubbed = []
  for (const [key, value] of Object.entries(input)) {
    if (/^(XAI|GROK)_/.test(key)) {
      scrubbed.push(key)
      continue
    }
    if (value !== undefined) env[key] = value
  }
  scrubbed.sort()
  return { env, scrubbed }
}

export function seedXaiCredential({ sourceAgentDir = dirname(sourceAuth), targetAgentDir }) {
  const source = JSON.parse(readFileSync(join(sourceAgentDir, "auth.json"), "utf8"))
  const xai = source?.xai
  if (!xai || typeof xai !== "object" || xai.type !== "oauth") throw new Error("xai oauth entry is unavailable")
  mkdirSync(targetAgentDir, { recursive: true })
  const path = join(targetAgentDir, "auth.json")
  writeFileSync(path, `${JSON.stringify({ xai: { type: "oauth", access: xai.access, refresh: xai.refresh, expires: xai.expires } })}\n`, { mode: 0o600 })
  return { path, seeded: true }
}

export function shredSeededCredential(path) {
  let overwrittenBytes = 0
  if (existsSync(path)) {
    const size = readFileSync(path).byteLength
    overwrittenBytes = size
    writeFileSync(path, randomBytes(Math.max(1, size)), { mode: 0o600 })
    rmSync(path, { force: true })
  }
  return { path, overwrittenBytes, removed: !existsSync(path) }
}

function scrubSecrets(text) {
  return String(text ?? "")
    .replace(/("(?:access|refresh|apiKey|token|password|secret)"\s*:\s*")[^"]*(")/gi, "$1[REDACTED]$2")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/(?:XAI_API_KEY|GROK_[A-Z0-9_]+)=\S+/g, "$1=[REDACTED]")
}

function findSenpi() {
  const requested = process.env.SENPI_BIN?.trim() || "senpi"
  if (requested.includes("/")) return existsSync(requested) ? requested : null
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = resolve(dir || ".", requested)
    if (existsSync(candidate)) return candidate
  }
  return null
}

function scriptFor(scenario) {
  if (scenario === "negative") return { parentSteps: [{ type: "tool_call", name: "tool_search", arguments: { query: "X posts", source: "mcp" } }, { type: "tool_call", name: "tool_search", arguments: { query: NEGATIVE_CONTROL_QUERY, source: "extension" } }, { type: "text", text: "Negative scenario complete." }], childSteps: [{ type: "text", text: "unused" }] }
  if (scenario === "reload-initial") return { parentSteps: [{ type: "text", text: "Ready to reload." }], childSteps: [{ type: "text", text: "unused" }] }
  const childSteps = scenario === "explore"
    ? [{ type: "tool_call", name: "tool_search", arguments: { query: "X posts" } }, { type: "tool_call", name: "x_search", arguments: { query: "xAI Grok CLI", from_date: yesterday } }, { type: "text", text: "Report the observed x_search call outcome." }]
    : [{ type: "tool_call", name: "tool_search", arguments: { query: "X posts" } }, { type: "tool_call", name: "x_search", arguments: { query: "xAI Grok CLI", from_date: yesterday } }, { type: "text", text: "Return the preceding x_search results verbatim." }]
  const target = { category: "quick" }
  return {
    parentSteps: [{ type: "tool_call", name: "task", arguments: { ...target, prompt: `Call the x_search tool with query "xAI Grok CLI" and from_date ${yesterday}; return its text verbatim`, run_in_background: false, name: `${scenario}-x-search` } }, { type: "text", text: `${scenario} root QA complete` }],
    childSteps,
  }
}

function observedToolCalls(transcript) {
  const calls = []
  const seen = new Set()
  for (const line of transcript.split(/\r?\n/)) {
    if (!line.includes('"type":"tool_execution_end"')) continue
    const match = line.match(/"toolName":"([^"]+)"/)
    if (match && !seen.has(match[1])) {
      seen.add(match[1])
      calls.push(match[1])
    }
  }
  return calls
}

function countToolExecutions(transcript, name) {
  return transcript.split(/\r?\n/).filter((line) => line.includes('"type":"tool_execution_end"') && line.includes(`"toolName":"${name}"`)).length
}

function toolSearchResults(transcript) {
  const queries = new Map()
  return transcript.split(/\r?\n/).flatMap((line) => {
    try {
      const event = JSON.parse(line)
      if (event?.type === "tool_execution_start" && event.toolName === "tool_search") {
        queries.set(event.toolCallId, event.args?.query)
        return []
      }
      if (event?.type !== "tool_execution_end" || event.toolName !== "tool_search") return []
      const text = event?.result?.content?.find((part) => part?.type === "text")?.text
      return typeof text === "string" ? [{ query: queries.get(event.toolCallId), text, isError: event.isError === true }] : []
    } catch {
      return []
    }
  })
}

export function skillHasX(transcript) {
  return /(?:skills-conditional[\\/]|<skill[^>]+name=["']|skillPaths[^\n]*[\\/])x-search|toolName["']?\s*:\s*["']x_search/i.test(transcript)
}

export function observeChildXSearchCall(transcript) {
  for (const line of transcript.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line)
      const observation = event?.payload
      if (event?.type === "tool_execution" && observation?.tool === "x_search") {
        return { observed: true, source: "child-tool-execution", isError: observation.is_error === true, outcome: observation.is_error === true ? "denied" : "success" }
      }
    } catch {}
  }
  return { observed: false, source: "child-tool-execution", outcome: "not-observed" }
}

function readSandboxTranscript(root) {
  const chunks = []
  const walk = (dir) => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/\.(json|jsonl|log|md|txt)$/.test(entry.name)) {
        try { chunks.push(readFileSync(path, "utf8")) } catch {}
      }
    }
  }
  walk(root)
  return scrubSecrets(chunks.join("\n"))
}

function runScenario(scenario, prompt, outDir) {
  const before = snapshotDirectory(realAgentDir)
  const beforeCredentials = credentialDigest(realAgentDir)
  const sandbox = createSandbox()
  seedSandbox(sandbox)
  let credentialReceipt
  const { env: scrubbedEnv, scrubbed } = createScrubbedEnvironment({ ...process.env })
  Object.assign(scrubbedEnv, {
    HOME: sandbox.homeDir, USERPROFILE: sandbox.homeDir,
    OMO_CODING_AGENT_DIR: sandbox.agentDir, SENPI_CODING_AGENT_DIR: sandbox.agentDir, PI_CODING_AGENT_DIR: sandbox.agentDir,
    XDG_CONFIG_HOME: sandbox.xdgConfigHome, XDG_DATA_HOME: sandbox.xdgDataHome, XDG_CACHE_HOME: sandbox.xdgCacheHome,
    PI_OFFLINE: "1", OMO_SENPI_QA: "1",
  })
  if (scenario !== "negative") credentialReceipt = seedXaiCredential({ targetAgentDir: sandbox.agentDir })
  mkdirSync(join(sandbox.cwd, ".omo"), { recursive: true })
  writeFileSync(join(sandbox.cwd, ".omo", "omo.json"), `${JSON.stringify({ categories: { quick: { description: "isolated x-search child QA", model: "omo-mock/mock-1" } }, agents: { librarian: { model: "omo-mock/mock-1" }, explore: { model: "omo-mock/mock-1" } } }, null, 2)}\n`)
  writeFileSync(join(sandbox.cwd, "mock-script.json"), `${JSON.stringify(scriptFor(scenario))}\n`)
  const sandboxExtensionDir = join(sandbox.root, "extensions")
  let sandboxExtensionPath = null
  if (scenario === "negative") {
    mkdirSync(sandboxExtensionDir, { recursive: true })
    sandboxExtensionPath = join(sandboxExtensionDir, "x-probe-tool.mjs")
    writeFileSync(sandboxExtensionPath, `export default function register(pi) { pi.registerTool({ name: "x_probe_tool", label: "Data probe", description: "Analyze the data with a local probe for catalog QA.", parameters: { type: "object", properties: {}, required: [] }, exposure: "search", searchKeywords: ["analyze the data"], allowLazyActivation: true, execute: async () => ({ content: [{ type: "text", text: "probe" }] }) }) }\n`)
  }
  const senpi = findSenpi()
  let run = { status: null, stdout: "", stderr: "" }
  if (senpi) {
    const common = ["-e", mockProviderEntry, ...(sandboxExtensionPath ? ["-e", sandboxExtensionPath] : []), "-p", "--mode", "json", "--provider", "omo-mock", "--model", "mock-1", "--session-dir", join(sandbox.root, "sessions")]
    const runOptions = { cwd: sandbox.cwd, env: scrubbedEnv, encoding: "utf8", timeout: 120000, maxBuffer: 64 * 1024 * 1024 }
    const runs = [spawnSync(senpi, [...common, prompt], runOptions)]
    if (scenario === "reload") {
      writeFileSync(join(sandbox.cwd, "mock-script.json"), `${JSON.stringify(scriptFor("reload-initial"))}\n`)
      runs.push(spawnSync(senpi, [...common, "--continue", "/reload"], runOptions))
      writeFileSync(join(sandbox.cwd, "mock-script.json"), `${JSON.stringify(scriptFor(scenario))}\n`)
      runs.push(spawnSync(senpi, [...common, "--continue", prompt], runOptions))
    }
    run = { status: (runs[0]?.status === 0 && runs.at(-1)?.status === 0) ? 0 : 1, stdout: runs.map((item) => item.stdout ?? "").join("\n"), stderr: runs.map((item) => item.stderr ?? "").join("\n") }
  }
  const transcript = scrubSecrets(`${run.stdout ?? ""}\n${run.stderr ?? ""}\n${readSandboxTranscript(sandbox.root)}`)
  const cleanup = credentialReceipt ? shredSeededCredential(credentialReceipt.path) : { removed: true, path: null, overwrittenBytes: 0 }
  const after = snapshotDirectory(realAgentDir)
  const changed = changedSnapshotPaths(before, after)
  const xSearchCalls = countToolExecutions(transcript, "x_search")
  const childXSearchCallOutcome = scenario === "explore" ? observeChildXSearchCall(transcript) : null
  const skillLoaded = skillHasX(transcript)
  const toolCalls = observedToolCalls(transcript)
  const searched = toolSearchResults(transcript)
  const negativeSearches = scenario === "negative" ? {
    tool_searchExecuted: searched.length === 2 && searched.every((result) => result.isError === false),
    noToolsMatched: searched.some((result) => result.query === "X posts" && result.text.includes("No tools matched")),
    controlMatched: searched.some((result) => result.query === NEGATIVE_CONTROL_QUERY && result.text.includes("x_probe_tool")),
  } : null
  const payload = {
    scenario, result: senpi === null ? "SKIP" : (run.status === 0 ? "PASS" : "FAIL"),
    ...(senpi === null ? { reason: "senpi-binary-unavailable" } : {}),
    prompt, yesterday, realSenpiUntouched: changed.length === 0, realSenpiChangedPaths: changed,
    realSenpiCredentialDigestUntouched: beforeCredentials === credentialDigest(realAgentDir),
    isolatedAgentDir: sandbox.agentDir, isolatedCwd: sandbox.cwd,
    envScrubbed: scrubbed, spawnedEnvHasXai: Object.keys(scrubbedEnv).some((key) => /^(XAI|GROK)_/.test(key)),
    toolCalls,
    ...(childXSearchCallOutcome ? { xSearchCallOutcome: childXSearchCallOutcome } : {}),
    toolResults: { noToolsMatched: negativeSearches?.noToolsMatched ?? false, controlMatched: negativeSearches?.controlMatched ?? false, tool_searchExecuted: negativeSearches?.tool_searchExecuted ?? false, controlQuery: scenario === "negative" ? NEGATIVE_CONTROL_QUERY : undefined, xSearchExecutions: xSearchCalls, xSearchResults: (transcript.match(/x_search results:/g) ?? []).length, xComUrls: (transcript.match(/https?:\/\/x\.com\/\S+/g) ?? []).length, unavailable: scenario === "explore" && childXSearchCallOutcome?.outcome === "denied" },
    negativePath: scenario === "negative" ? { kind: "sandbox-extension", extension: "x_probe_tool", exposure: "search", source: "QA sandbox", shippedSkillQuery: NEGATIVE_CONTROL_QUERY, xQueryScope: "mcp", controlQueryScope: "extension", xaiInvolved: false, mcpInvolved: false } : undefined,
    ...(scenario === "negative" ? { xSearchSkillListed: skillLoaded } : {}),
    registrationCount: (transcript.match(/x-search registered/g) ?? []).length,
    verdict: { noXSearch: scenario === "negative" ? !skillLoaded && xSearchCalls === 0 : undefined, negativeToolSearch: scenario === "negative" ? negativeSearches?.tool_searchExecuted && negativeSearches.noToolsMatched && negativeSearches.controlMatched : undefined, positive: scenario !== "negative" && scenario !== "explore" ? (transcript.match(/x_search results:/g) ?? []).length >= 1 : undefined, exploreUnavailable: scenario === "explore" ? childXSearchCallOutcome?.outcome === "denied" && (transcript.match(/x_search results:/g) ?? []).length === 0 : undefined, reload: scenario === "reload" ? transcript.includes("/reload") && (transcript.match(/x_search results:/g) ?? []).length >= 2 && (transcript.match(/x-search registered/g) ?? []).length === 3 : undefined },
    senpiExit: run.status, senpiSignal: run.signal ?? null,
    transcript: `transcript-${scenario}.txt`, cleanup,
  }
  if (outDir) {
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, `${scenario}.json`), `${JSON.stringify(payload, null, 2)}\n`)
    writeFileSync(join(outDir, `transcript-${scenario}.txt`), transcript)
  }
  rmSync(sandbox.root, { recursive: true, force: true })
  return payload
}

function parseArgs(argv) {
  const options = {}
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--scenario") options.scenario = argv[++i]
    else if (argv[i] === "--prompt") options.prompt = argv[++i]
    else if (argv[i] === "--out") options.out = argv[++i]
    else if (argv[i] === "--self-test") options.selfTest = true
  }
  return options
}

function main() {
  const options = parseArgs(process.argv)
  if (options.selfTest) { createScrubbedEnvironment({ XAI_API_KEY: "x", SAFE: "y" }); console.log("SELF-TEST OK"); return }
  if (!scenarios.has(options.scenario) || typeof options.prompt !== "string") throw new Error("usage: --scenario negative|positive|reload|child|librarian|explore --prompt <text> --out <dir>")
  const payload = runScenario(options.scenario, options.prompt, options.out && resolve(options.out))
  console.log(JSON.stringify(payload))
  if (payload.result === "FAIL") process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
