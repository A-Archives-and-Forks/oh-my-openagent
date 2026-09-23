#!/usr/bin/env node
// Manual QA driver for model profiles (`model_profile` / `model_profiles` in omo.json): proves on a
// REAL senpi process with an isolated home that the profile component selects the main-session
// model through the SESSION-ONLY setter and never persists it.
//   node model-profile-e2e.mjs [--bundle <pluginDir>] [--scenario <name>]
// Scenarios (all run by default, each in its own throwaway sandbox):
//   daily-normal-opus / daily-heavy-fable / geeky-normal-sol-fast / geeky-heavy-astra
//                    each leaf's first rung + thinking level in the applied notice.
//   daily-normal-kimi / daily-normal-glm  later Daily · Normal rungs.
//   geeky-normal-nonfast-sol-omo-mock  gpt-6-sol medium via omo-mock model-id matching (not a github-copilot registration).
//   unset            empty omo.json applies Daily · Normal (kimi-k3 here).
//   empty-registry   Daily · Normal against only mock-1: unavailable, session keeps mock-1.
//   literal-pin      model_profile "anthropic/claude-opus-5": that model id is applied.
//   unknown-profile / capable-removed / deep-work-removed / simple-work-removed
//                    unknown-profile notice listing the four lane ids.
//   custom-profile   user model_profiles.night-shift applies its chain.
//   cli-model-wins   `--model` (provenance "cli") with an active lane: the CLI model survives.
//   lane-beats-recommended-models  senpi recommended-models first auto-switches to gpt-5.6-sol;
//                    Daily · Normal still wins with glm-5.3.
// Isolation: SENPI_CODING_AGENT_DIR + XDG_CONFIG_HOME point at a throwaway sandbox; the real
// ~/.senpi/agent credential files are digest-compared before/after and MUST stay identical.
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"

import { createSandbox } from "./drive.mjs"

const HOST_VOLATILE_SETTINGS_KEYS = ["workflow-skills", "tipsHistory", "skills"]

function isolationDigest(agentDir) {
  const hash = createHash("sha256")
  for (const name of ["auth.json", "models.json", "trust.json"]) {
    const path = join(agentDir, name)
    hash.update(name)
    hash.update("\0")
    hash.update(existsSync(path) ? readFileSync(path) : Buffer.from("absent"))
    hash.update("\0")
  }
  const settingsPath = join(agentDir, "settings.json")
  if (existsSync(settingsPath)) {
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"))
    for (const key of HOST_VOLATILE_SETTINGS_KEYS) delete settings[key]
    hash.update(JSON.stringify(settings))
  } else {
    hash.update("settings-absent")
  }
  return hash.digest("hex")
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

const scriptDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(scriptDir, "..", "..")
const defaultPluginRoot = join(packageRoot, "plugin")
const mockProviderEntry = join(scriptDir, "model-profile-e2e-mock-provider.ts")
const STREAM_CAPTURES_FILE = "model-profile-stream-captures.jsonl"
const realSenpiAgentDir = join(homedir(), ".senpi", "agent")

const APPLIED_TYPE = "omo-model-profile:applied"
const UNKNOWN_TYPE = "omo-model-profile:unknown"
const UNAVAILABLE_TYPE = "omo-model-profile:unavailable"
const PROFILE_TYPES = [APPLIED_TYPE, UNKNOWN_TYPE, UNAVAILABLE_TYPE]

// The mock provider registers under `omo-mock`; a builtin provider id cannot be impersonated
// (senpi merges the builtin's real baseUrl over the registration), so tier rungs and the literal
// pin resolve through the same cross-provider matcher a category chain uses. `mock-1` is the model
// senpi's own resolution picks when nothing is pinned (first-available), so "no model change" is
// observable as the turn running on `mock-1`. senpi's `recommended-models` builtin auto-switches a
// first-available session to kimi-k3 / claude-opus-5 / ... whenever one is in the registry, which
// would mask the profile; the sandbox `settings.json` therefore lists `mock-1` as the recommended
// model so the builtin stays active but inert, except in the scenario that proves the precedence.
const KNOWN_LANES = "daily-heavy, daily-normal, geeky-heavy, geeky-normal"

const SCENARIOS = {
  "daily-normal-opus": {
    omoConfig: { model_profile: "daily-normal" },
    mockModels: ["mock-1", "claude-opus-5-5"],
    cliModel: undefined,
    expect: { model: "claude-opus-5-5", notice: APPLIED_TYPE, thinking: "medium" },
  },
  "daily-heavy-fable": {
    omoConfig: { model_profile: "daily-heavy" },
    mockModels: ["mock-1", "claude-fable-5-1"],
    cliModel: undefined,
    expect: { model: "claude-fable-5-1", notice: APPLIED_TYPE, thinking: "xhigh" },
  },
  "geeky-normal-sol-fast": {
    omoConfig: { model_profile: "geeky-normal" },
    mockModels: ["mock-1", "gpt-6-sol-fast"],
    cliModel: undefined,
    expect: { model: "gpt-6-sol-fast", notice: APPLIED_TYPE, thinking: "medium" },
  },
  "geeky-heavy-astra": {
    omoConfig: { model_profile: "geeky-heavy" },
    mockModels: ["mock-1", "gpt-6-astra"],
    cliModel: undefined,
    expect: { model: "gpt-6-astra", notice: APPLIED_TYPE, thinking: "xhigh" },
  },
  "daily-normal-kimi": {
    omoConfig: { model_profile: "daily-normal" },
    mockModels: ["mock-1", "kimi-k3"],
    cliModel: undefined,
    expect: { model: "kimi-k3", notice: APPLIED_TYPE, thinking: "max" },
  },
  "daily-normal-glm": {
    omoConfig: { model_profile: "daily-normal" },
    mockModels: ["mock-1", "glm-5.3"],
    cliModel: undefined,
    expect: { model: "glm-5.3", notice: APPLIED_TYPE, thinking: "max" },
  },
  "geeky-normal-nonfast-sol-omo-mock": {
    omoConfig: { model_profile: "geeky-normal" },
    mockModels: ["mock-1", "gpt-6-sol"],
    cliModel: undefined,
    expect: { model: "gpt-6-sol", notice: APPLIED_TYPE, thinking: "medium" },
  },
  unset: {
    omoConfig: {},
    mockModels: ["mock-1", "kimi-k3"],
    cliModel: undefined,
    expect: { model: "kimi-k3", notice: APPLIED_TYPE, thinking: "max" },
  },
  "empty-registry": {
    omoConfig: { model_profile: "daily-normal" },
    mockModels: ["mock-1"],
    cliModel: undefined,
    expect: { model: "mock-1", notice: UNAVAILABLE_TYPE },
  },
  "literal-pin": {
    omoConfig: { model_profile: "anthropic/claude-opus-5" },
    mockModels: ["mock-1", "claude-opus-5"],
    cliModel: undefined,
    expect: { model: "claude-opus-5", notice: APPLIED_TYPE },
  },
  "unknown-profile": {
    omoConfig: { model_profile: "nope" },
    mockModels: ["mock-1", "kimi-k3"],
    cliModel: undefined,
    expect: { model: "mock-1", notice: UNKNOWN_TYPE },
  },
  "capable-removed": {
    omoConfig: { model_profile: "capable" },
    mockModels: ["mock-1", "kimi-k3"],
    cliModel: undefined,
    expect: { model: "mock-1", notice: UNKNOWN_TYPE },
  },
  "deep-work-removed": {
    omoConfig: { model_profile: "deep-work" },
    mockModels: ["mock-1", "gpt-6-sol"],
    cliModel: undefined,
    expect: { model: "mock-1", notice: UNKNOWN_TYPE },
  },
  "simple-work-removed": {
    omoConfig: { model_profile: "simple-work" },
    mockModels: ["mock-1", "gpt-6-luna-fast"],
    cliModel: undefined,
    expect: { model: "mock-1", notice: UNKNOWN_TYPE },
  },
  "custom-profile": {
    omoConfig: {
      model_profile: "night-shift",
      model_profiles: { "night-shift": { display_name: "Night shift", models: ["mock-1"] } },
    },
    mockModels: ["mock-1", "kimi-k3"],
    cliModel: undefined,
    expect: { model: "mock-1", notice: APPLIED_TYPE },
  },
  "scoped-custom-openai-missing": {
    omoConfig: {
      model_profile: "geeky-normal",
      model_profiles: {
        "geeky-normal": {
          display_name: "Office GPT",
          models: [{ model: "openai/gpt-6-sol", reasoning: "high" }],
        },
      },
    },
    mockModels: ["mock-1", "gpt-6-sol", "gpt-6-sol-fast"],
    cliModel: undefined,
    expect: { model: "mock-1", notice: UNAVAILABLE_TYPE },
  },
  "custom-geeky-openai-reasoning": {
    omoConfig: {
      model_profile: "geeky-normal",
      model_profiles: {
        "geeky-normal": {
          display_name: "Office GPT",
          models: [{ model: "openai/gpt-6-sol", reasoning: "high" }],
        },
      },
    },
    mockModels: ["mock-1", "gpt-6-sol-fast", "gpt-6-sol"],
    cliModel: undefined,
    registerOpenai: true,
    expect: { model: "gpt-6-sol", provider: "openai", notice: APPLIED_TYPE, thinking: "high" },
  },
  "cli-model-wins": {
    omoConfig: { model_profile: "daily-normal" },
    mockModels: ["mock-1", "claude-opus-5-5"],
    cliModel: "mock-1",
    cliThinking: "low",
    expect: { model: "mock-1", notice: null, thinking: "low" },
  },
  "lane-beats-recommended-models": {
    omoConfig: { model_profile: "daily-normal" },
    mockModels: ["mock-1", "glm-5.3", "gpt-5.6-sol"],
    cliModel: undefined,
    recommendedModels: undefined,
    expect: { model: "glm-5.3", notice: APPLIED_TYPE, thinking: "max" },
  },
}

function parseArgs(argv) {
  const args = { bundle: defaultPluginRoot, scenarios: Object.keys(SCENARIOS) }
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i]
    const value = argv[i + 1]
    if (key === "--bundle") args.bundle = resolve(value)
    else if (key === "--scenario") {
      if (!(value in SCENARIOS)) throw new Error(`unknown scenario: ${value}`)
      args.scenarios = [value]
    } else throw new Error(`unknown argument: ${key}`)
  }
  return args
}

function findOnPath(bin) {
  if (bin.includes("/")) return existsSync(bin) ? bin : null
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = resolve(dir || ".", bin)
    if (existsSync(candidate)) return candidate
  }
  return null
}

function seedScenario(pluginRoot, scenario) {
  const sandbox = createSandbox()
  mkdirSync(sandbox.cwd, { recursive: true })
  mkdirSync(sandbox.agentDir, { recursive: true })
  mkdirSync(sandbox.xdgConfigHome, { recursive: true })
  const settingsPath = join(sandbox.agentDir, "settings.json")
  const settings = { defaultProjectTrust: "ask", packages: [pluginRoot] }
  if (!("recommendedModels" in scenario)) settings.recommendedModels = ["mock-1"]
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`)
  writeFileSync(join(sandbox.agentDir, "trust.json"), `${JSON.stringify({ [sandbox.canonicalCwd]: true }, null, 2)}\n`)
  const sessionDir = join(sandbox.root, "sessions")
  mkdirSync(sessionDir, { recursive: true })
  const omoDir = join(sandbox.cwd, ".omo")
  mkdirSync(omoDir, { recursive: true })
  writeFileSync(join(omoDir, "omo.json"), `${JSON.stringify(scenario.omoConfig, null, 2)}\n`)
  const script = {
    models: scenario.mockModels,
    parentSteps: [{ type: "text", text: "model profile scenario complete" }],
    childSteps: [{ type: "text", text: "unused" }],
  }
  writeFileSync(join(sandbox.cwd, "mock-script.json"), `${JSON.stringify(script, null, 2)}\n`)
  return { sandbox, sessionDir, settingsPath }
}

function readSessionEntries(sessionDir) {
  const entries = []
  const walk = (dir) => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile() && path.endsWith(".jsonl")) {
        for (const line of readFileSync(path, "utf8").split("\n")) {
          if (line.trim().length === 0) continue
          try {
            entries.push(JSON.parse(line))
          } catch {
            // partial trailing line: ignore
          }
        }
      }
    }
  }
  walk(sessionDir)
  return entries
}

// An omo/senpi session exports its own runtime locators; a child senpi that inherits them boots
// against that runtime dir instead of the binary on PATH, so they are dropped from the spawn env.
const INHERITED_RUNTIME_KEYS = ["SENPI_PACKAGE_DIR", "OMO_PACKAGE_DIR", "OMO_BIN", "PI_SESSION_FILE"]

function spawnEnv(sandbox, sessionDir, scenario) {
  const env = { ...process.env }
  for (const key of INHERITED_RUNTIME_KEYS) delete env[key]
  if (scenario.registerOpenai === true) env.OMO_PROFILE_QA_REGISTER_OPENAI = "1"
  else delete env.OMO_PROFILE_QA_REGISTER_OPENAI
  return {
    ...env,
    SENPI_CODING_AGENT_DIR: sandbox.agentDir,
    XDG_CONFIG_HOME: sandbox.xdgConfigHome,
    XDG_DATA_HOME: sandbox.xdgDataHome,
    XDG_CACHE_HOME: sandbox.xdgCacheHome,
    SENPI_CODING_AGENT_SESSION_DIR: sessionDir,
    OMO_SENPI_QA: "1",
  }
}

function readThinkingField(source) {
  if (typeof source !== "object" || source === null) return null
  for (const key of ["thinkingLevel", "thinking_level", "level", "reasoning"]) {
    const value = source[key]
    if (typeof value === "string") return value
  }
  return null
}

function loadStreamCaptures(cwd) {
  const path = join(cwd, STREAM_CAPTURES_FILE)
  if (!existsSync(path)) return []
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
}

function observeEngineThinking(entries, captures) {
  const changes = entries.filter((entry) => entry.type === "thinking_level_change")
  const lastAssistant = entries.filter((entry) => entry.type === "message" && entry.message?.role === "assistant").at(-1)
  const fromCapture = captures.map((capture) => capture.thinking).find((value) => typeof value === "string" && value.length > 0) ?? null
  const fromChange = readThinkingField(changes.at(-1)) ?? changes.at(-1)?.thinkingLevel ?? changes.at(-1)?.level ?? null
  const fromAssistant = lastAssistant?.message?.thinkingLevel ?? lastAssistant?.thinkingLevel ?? null
  return {
    observed: fromChange ?? fromCapture ?? fromAssistant ?? null,
    fromChange,
    fromCapture,
    fromAssistant,
    captures,
    changeCount: changes.length,
    entryTypes: [...new Set(entries.map((entry) => entry.type))],
  }
}

function runScenario(name, scenario, args, senpiBin) {
  const { sandbox, sessionDir, settingsPath } = seedScenario(args.bundle, scenario)
  const settingsBefore = sha256File(settingsPath)
  const modelArgs = scenario.cliModel === undefined ? [] : ["--provider", "omo-mock", "--model", scenario.cliModel]
  const thinkingArgs = scenario.cliThinking === undefined ? [] : ["--thinking", scenario.cliThinking]
  try {
    const run = spawnSync(
      senpiBin,
      ["-e", mockProviderEntry, "-p", "--mode", "json", ...modelArgs, ...thinkingArgs, "--session-dir", sessionDir, "run the scripted scenario"],
      {
        cwd: sandbox.cwd,
        env: spawnEnv(sandbox, sessionDir, scenario),
        encoding: "utf8",
        timeout: 120_000,
        maxBuffer: 64 * 1024 * 1024,
      },
    )
    const settingsAfter = sha256File(settingsPath)
    const entries = readSessionEntries(sessionDir)
    const assistantMessages = entries
      .filter((entry) => entry.type === "message" && entry.message?.role === "assistant")
      .map((entry) => ({ provider: entry.message.provider, model: entry.message.model }))
    const profileNotices = entries
      .filter((entry) => entry.type === "custom_message" && PROFILE_TYPES.includes(entry.customType))
      .map((entry) => ({ customType: entry.customType, content: entry.content, details: entry.details ?? null }))
    const lastAssistant = assistantMessages.at(-1) ?? null

    const checks = {
      exit_zero: run.status === 0,
      turn_ran: run.stdout.includes("model profile scenario complete"),
      settings_json_unchanged: scenario.cliThinking === undefined ? settingsBefore === settingsAfter : true,
      turn_model: lastAssistant?.model === scenario.expect.model,
      notice:
        scenario.expect.notice === null
          ? profileNotices.length === 0
          : profileNotices.length === 1 && profileNotices[0].customType === scenario.expect.notice,
    }
    const provider = scenario.expect.provider ?? "omo-mock"
    const engine = observeEngineThinking(entries, loadStreamCaptures(sandbox.cwd))
    if (scenario.expect.notice === APPLIED_TYPE) {
      const applied = profileNotices[0]
      checks.notice_names_model = applied?.content.includes(`selected ${provider}/${scenario.expect.model}`) === true
      checks.applied_details = applied?.details?.model === `${provider}/${scenario.expect.model}`
      if (scenario.expect.thinking !== undefined) {
        checks.notice_names_thinking =
          applied?.content.includes(`${provider}/${scenario.expect.model} ${scenario.expect.thinking}`) === true
        checks.details_thinking = applied?.details?.reasoning === scenario.expect.thinking
      }
    }
    if (scenario.expect.thinking !== undefined) {
      checks.engine_thinking = engine.observed === scenario.expect.thinking
    }
    if (scenario.expect.thinkingAbsent !== undefined) {
      checks.engine_thinking_not_profile = engine.observed !== scenario.expect.thinkingAbsent
    }
    if (scenario.expect.provider !== undefined) {
      checks.stream_provider = engine.captures.some((capture) => capture.provider === scenario.expect.provider) === true
    }
    if (name === "daily-normal-kimi") {
      const applied = profileNotices[0]
      checks.notice_lists_skipped =
        applied?.content.includes("skipped: anthropic-subscription/claude-opus-5-5") === true
      checks.notice_mentions_retry_chains = applied?.content.includes("retry chains") === true
    }
    if (name === "unset") {
      checks.default_lane = profileNotices[0]?.details?.profile === "daily-normal"
    }
    if (name === "empty-registry") {
      checks.unavailable_names_registry = profileNotices[0]?.content.includes("model registry") === true
      checks.unavailable_does_not_infer_auth = /connected/i.test(profileNotices[0]?.content ?? "") === false
    }
    if (name === "unknown-profile") {
      checks.notice_lists_known_profiles =
        profileNotices[0]?.content.includes(`model_profile "nope" is not defined; known profiles: ${KNOWN_LANES}`) === true
    }
    if (name === "capable-removed" || name === "deep-work-removed" || name === "simple-work-removed") {
      const retired = name.replace("-removed", "")
      checks.notice_lists_remaining_profiles =
        profileNotices[0]?.content.includes(`model_profile "${retired}" is not defined; known profiles: ${KNOWN_LANES}`) === true
    }
    if (name === "lane-beats-recommended-models") {
      const changes = entries.filter((entry) => entry.type === "model_change").map((entry) => entry.modelId)
      checks.recommended_models_switched_first = changes.indexOf("gpt-5.6-sol") !== -1 && changes.indexOf("gpt-5.6-sol") < changes.lastIndexOf("glm-5.3")
    }
    if (name === "cli-model-wins") {
      checks.cli_model_kept = lastAssistant?.provider === "omo-mock" && lastAssistant?.model === "mock-1"
    }

    return {
      scenario: name,
      result: Object.values(checks).every((value) => value === true) ? "PASS" : "FAIL",
      checks,
      settingsSha256: { before: settingsBefore, after: settingsAfter },
      turnModel: lastAssistant,
      profileNotices,
      engineThinking: engine,
      modelChanges: entries.filter((entry) => entry.type === "model_change").map((entry) => `${entry.provider}/${entry.modelId}`),
      stderrTail: (run.stderr ?? "").split("\n").filter((line) => line.trim().length > 0).slice(-4),
    }
  } finally {
    rmSync(sandbox.root, { recursive: true, force: true })
    console.error(`cleanup: removed sandbox ${sandbox.root}`)
  }
}

function main() {
  const wrongThinking = process.env.OMO_PROFILE_QA_WRONG_THINKING?.trim()
  if (wrongThinking !== undefined && wrongThinking.length > 0 && SCENARIOS["daily-normal-opus"] !== undefined) {
    SCENARIOS["daily-normal-opus"].expect.thinking = wrongThinking
  }
  const args = parseArgs(process.argv)
  const senpiBin = findOnPath(process.env.SENPI_BIN?.trim() || "senpi")
  if (senpiBin === null) {
    console.log(JSON.stringify({ result: "SKIP", reason: "senpi-binary-unavailable" }))
    return
  }
  const beforeCredentials = isolationDigest(realSenpiAgentDir)
  const scenarios = args.scenarios.map((name) => runScenario(name, SCENARIOS[name], args, senpiBin))
  const afterCredentials = isolationDigest(realSenpiAgentDir)
  const realSenpiCredentialsUntouched = beforeCredentials === afterCredentials
  const passed = scenarios.every((scenario) => scenario.result === "PASS") && realSenpiCredentialsUntouched
  console.log(JSON.stringify({ result: passed ? "PASS" : "FAIL", bundle: args.bundle, realSenpiCredentialsUntouched, scenarios }, null, 2))
  process.exitCode = passed ? 0 : 1
}

main()
