import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { createSandbox, seedSandbox } from "./drive.mjs"

const scriptDir = dirname(fileURLToPath(import.meta.url))
const mockProvider = join(scriptDir, "mock-provider", "index.ts")

export const ALPHA = "Wait for alpha approval"
export const BETA = "Wait for beta approval"

export function scenarioEnv(sandbox, sessionDir) {
  const home = join(sandbox.root, "home")
  mkdirSync(home, { recursive: true })
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: sandbox.xdgConfigHome,
    SENPI_CODING_AGENT_DIR: sandbox.agentDir,
    SENPI_CODING_AGENT_SESSION_DIR: sessionDir,
    PI_CODING_AGENT_DIR: sandbox.agentDir,
    PI_CODING_AGENT_SESSION_DIR: sessionDir,
    OMO_SENPI_QA: "1",
  }
}

export function writeScript(cwd, steps) {
  writeFileSync(join(cwd, "mock-script.json"), `${JSON.stringify({ steps }, null, 2)}\n`)
}

export function runPrint({ senpiBin, sandbox, sessionDir, prompt, steps, continuation = false }) {
  writeScript(sandbox.cwd, steps)
  return spawnSync(
    senpiBin,
    [
      "-e",
      mockProvider,
      "-p",
      "--provider",
      "omo-mock",
      "--model",
      "mock-1",
      "--session-dir",
      sessionDir,
      ...(continuation ? ["-c"] : []),
      prompt,
    ],
    {
      cwd: sandbox.cwd,
      env: scenarioEnv(sandbox, sessionDir),
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 64 * 1024 * 1024,
    },
  )
}

export function readSessionEntries(sessionDir) {
  const entries = []
  const walk = (dir) => {
    if (!existsSync(dir)) return
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, item.name)
      if (item.isDirectory()) walk(full)
      else if (item.name.endsWith(".jsonl")) {
        for (const line of readFileSync(full, "utf8").split("\n")) {
          if (line.trim() === "") continue
          try {
            entries.push(JSON.parse(line))
          } catch {
            // A partially flushed final line is not evidence.
          }
        }
      }
    }
  }
  walk(sessionDir)
  return entries
}

export function collectCustomType(value, type, found = []) {
  if (typeof value !== "object" || value === null) return found
  if (Reflect.get(value, "customType") === type) found.push(value)
  for (const nested of Object.values(value)) collectCustomType(nested, type, found)
  return found
}

export function latestTodoState(entries) {
  const states = collectCustomType(entries, "senpi.todo-state")
  return states.length === 0 ? undefined : states.at(-1)
}

export function seedScenario(senpiBin, terminal = false) {
  const sandbox = createSandbox()
  seedSandbox(sandbox)
  const skillDir = join(sandbox.agentDir, "skills", "qa-continuity")
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(
    join(skillDir, "SKILL.md"),
    "---\nname: qa-continuity\ndescription: QA-only leading skill command fixture.\n---\n\nPreserve this queued input.\n",
  )
  const sessionDir = join(sandbox.root, "sessions")
  mkdirSync(sessionDir, { recursive: true })
  const seed = runPrint({
    senpiBin,
    sandbox,
    sessionDir,
    prompt: "seed approval todos",
    steps: todoInitSteps(terminal),
  })
  if (seed.status !== 0) throw new Error(`todo seed failed: ${String(seed.stderr).slice(-500)}`)
  return { sandbox, sessionDir, mockProvider }
}

function todoInitSteps(terminal) {
  const steps = [
    {
      type: "tool_call",
      name: "todo",
      arguments: { op: "init", list: [{ phase: "Approvals", items: [ALPHA, BETA] }] },
    },
  ]
  if (terminal) {
    steps.push(
      { type: "tool_call", name: "todo", arguments: { op: "done", task: ALPHA } },
      { type: "tool_call", name: "todo", arguments: { op: "done", task: BETA } },
    )
  }
  steps.push({ type: "text", text: terminal ? "all approvals closed" : "approvals seeded" })
  return steps
}
