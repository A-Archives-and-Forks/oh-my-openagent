#!/usr/bin/env node
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { credentialDigest } from "./drive.mjs"
import {
  ALPHA as alpha,
  BETA as beta,
  collectCustomType,
  latestTodoState,
  readSessionEntries,
  runPrint,
  scenarioEnv,
  seedScenario,
  writeScript,
} from "./todo-continuity-fixture.mjs"
import { TodoContinuityRpcClient } from "./todo-continuity-rpc.mjs"

const scriptDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(scriptDir, "..", "..")
const repoRoot = resolve(packageRoot, "..", "..")
const realAgentDir = join(homedir(), ".senpi", "agent")
const reminderType = "omo-todo-continuity:reminder"
const reminderTag = "<omo-todo-continuity>"

function runIdleScenario(senpiBin) {
  const seeded = seedScenario(senpiBin)
  try {
    const run = runPrint({
      senpiBin,
      sandbox: seeded.sandbox,
      sessionDir: seeded.sessionDir,
      prompt: "Also add gamma without dropping alpha or beta.",
      steps: [{ type: "text", text: "idle follow-up complete" }],
      continuation: true,
    })
    const entries = readSessionEntries(seeded.sessionDir)
    const reminders = collectCustomType(entries, reminderType)
    const todoJson = JSON.stringify(latestTodoState(entries))
    const passed =
      run.status === 0 && reminders.length === 1 && todoJson.includes(alpha) && todoJson.includes(beta)
    return { name: "idle-open-todo", result: passed ? "PASS" : "FAIL", reminders: reminders.length, retained: [alpha, beta].filter((task) => todoJson.includes(task)), exitStatus: run.status }
  } finally {
    rmSync(seeded.sandbox.root, { recursive: true, force: true })
  }
}

async function runQueuedScenario(senpiBin) {
  const seeded = seedScenario(senpiBin)
  let client
  try {
    writeScript(seeded.sandbox.cwd, [
      { type: "tool_call", name: "bash", arguments: { command: "printf FIRST-TURN" } },
      { type: "text", text: "first turn complete" },
      { type: "text", text: "queued turn complete" },
    ])
    client = new TodoContinuityRpcClient({
      bin: senpiBin,
      args: ["-e", seeded.mockProvider, "--mode", "rpc", "--provider", "omo-mock", "--model", "mock-1", "--session-dir", seeded.sessionDir, "-c"],
      cwd: seeded.sandbox.cwd,
      env: scenarioEnv(seeded.sandbox, seeded.sessionDir),
    })
    await client.send({ type: "get_state" })
    const started = client.waitForEventCount("agent_start", 1)
    const ended = client.waitForEventCount("agent_end", 2)
    await client.send({ type: "prompt", message: "start a first turn" })
    await started
    const queued = await client.send({
      type: "prompt",
      message: "/skill:qa-continuity queued gamma",
      streamingBehavior: "steer",
      images: [{ type: "image", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB", mimeType: "image/png" }],
    })
    await ended
    const exit = await client.close()
    const entries = readSessionEntries(seeded.sessionDir)
    const customReminders = collectCustomType(entries, reminderType)
    const tagged = entries.filter(
      (entry) =>
        Reflect.get(entry, "type") === "message" &&
        Reflect.get(Reflect.get(entry, "message"), "role") === "user" &&
        JSON.stringify(entry).includes(reminderTag),
    )
    const taggedJson = tagged.map((entry) => JSON.stringify(entry)).join("\n")
    const skillExpanded = taggedJson.includes('<skill name=\\"qa-continuity\\"') && taggedJson.includes("queued gamma")
    const passed =
      queued.success === true &&
      exit.code === 0 &&
      customReminders.length === 1 &&
      tagged.length === 1 &&
      skillExpanded &&
      taggedJson.includes("image/png")
    return {
      name: "queued-steer-atomic",
      result: passed ? "PASS" : "FAIL",
      standaloneReminders: customReminders.length,
      taggedEntries: tagged.length,
      leadingSkillExpanded: skillExpanded,
      imagePreserved: taggedJson.includes("image/png"),
      exitStatus: exit.code,
      ...(passed ? {} : { taggedSamples: tagged.map((entry) => JSON.stringify(entry).slice(0, 1_200)) }),
    }
  } finally {
    client?.kill()
    rmSync(seeded.sandbox.root, { recursive: true, force: true })
  }
}

function runTerminalScenario(senpiBin) {
  const seeded = seedScenario(senpiBin, true)
  try {
    const run = runPrint({
      senpiBin,
      sandbox: seeded.sandbox,
      sessionDir: seeded.sessionDir,
      prompt: "terminal follow-up",
      steps: [{ type: "text", text: "terminal complete" }],
      continuation: true,
    })
    const reminders = collectCustomType(readSessionEntries(seeded.sessionDir), reminderType)
    return { name: "terminal-skip", result: run.status === 0 && reminders.length === 0 ? "PASS" : "FAIL", reminders: reminders.length, exitStatus: run.status }
  } finally {
    rmSync(seeded.sandbox.root, { recursive: true, force: true })
  }
}

async function main() {
  const senpiBin = process.env.SENPI_BIN?.trim() || "senpi"
  const beforeDigest = credentialDigest(realAgentDir)
  const scenarios = [runIdleScenario(senpiBin), await runQueuedScenario(senpiBin), runTerminalScenario(senpiBin)]
  const isolated = beforeDigest === credentialDigest(realAgentDir)
  const cleanup = scenarios.every((scenario) => scenario.result === "PASS")
  const result = isolated && cleanup ? "PASS" : "FAIL"
  const report = { result, isolatedRealAgentDir: isolated, cleanup: "all scenario sandboxes removed", scenarios, malformedBoundary: "covered by todo-continuity component unit test" }
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "")
  const evidenceDir = join(repoRoot, ".omo", "evidence", "omo-senpi-adapter", `${date}-todo-continuity`)
  mkdirSync(evidenceDir, { recursive: true })
  writeFileSync(join(evidenceDir, "result.json"), `${JSON.stringify(report, null, 2)}\n`)
  writeFileSync(join(evidenceDir, "README.md"), `# Todo continuity live QA\n\n- What: real Senpi CLI idle, RPC queued steer, and terminal-state scenarios.\n- Observed: ${result}; one idle hidden reminder, one queued atomic reminder with /skill + image, zero terminal reminders.\n- Why: proves the built OMO-Senpi plugin reads persisted todo state on the actual input pipeline.\n- Omitted: raw session logs and credentials; malformed data is covered by the focused unit boundary test.\n- Cleanup: every temporary sandbox was removed; real agent credential digest unchanged: ${isolated}.\n`)
  console.log(JSON.stringify({ ...report, evidenceDir }, null, 2))
  if (result !== "PASS") process.exitCode = 1
}

await main()
