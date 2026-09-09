#!/usr/bin/env node
import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { EventEmitter, once } from "node:events"
import { createServer } from "node:http"
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import { createSandbox, seedSandbox, credentialDigest } from "./drive.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, "../../../..")
const evidence = execFileSync(process.execPath, [join(root, ".agents/skills/senpi-qa/scripts/resolve-evidence-dir.mjs"),
  "--repo-root", root, "--slug", process.env.POLICY_QA_SLUG ?? "20260909-policy-continuation-hooks"], { encoding: "utf8" }).trim()
mkdirSync(evidence, { recursive: true })
const bun = process.env.BUN_BIN ?? "bun"
const cli = realpathSync(process.env.SENPI_BIN ?? join(root, "node_modules/@code-yeongyu/senpi/dist/cli.js"))
const toolkit = join(root, "packages/omo-senpi/plugin/runtime/agent-toolkit/omo-agent-toolkit")
const policyError = "Codex error: This request was blocked by our safety systems. Reason: Potentially unintended activity."
const realHomes = [join(homedir(), ".senpi", "agent"), join(homedir(), ".omo", "agent")]
const before = realHomes.map(credentialDigest)
const reports = []

function trace(path) {
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
}

async function scenario(lane, failure) {
  const sandbox = createSandbox()
  const name = `${lane}-${failure}`
  const traceFile = join(evidence, `${name}-hooks.jsonl`)
  const events = []
  let child
  let server
  let lines
  let calls = 0
  let phase = "failure"
  let stderr = ""
  let cleanup
  writeFileSync(traceFile, "")
  try {
    seedSandbox(sandbox)
    writeFileSync(join(sandbox.agentDir, "settings.json"), JSON.stringify({ packages: [],
      retry: { enabled: false }, compaction: { enabled: false }, sessionTitle: { enabled: false } }))
    const extension = join(sandbox.root, "extension.mjs")
    execFileSync(bun, ["build", join(here, "fixtures/policy-continuation-extension.ts"), "--target", "node", "--outfile", extension], { cwd: root })
    server = createServer((_request, response) => {
      calls++
      const outcome = phase === "failure"
        ? failure === "policy" ? { stopReason: "error", errorMessage: policyError }
          : { stopReason: "toolUse", stopDetails: { type: "refusal" } }
        : { stopReason: "stop", content: [{ type: "text", text: policyError }] }
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify(outcome))
    })
    const listening = once(server, "listening", { signal: AbortSignal.timeout(10_000) })
    server.listen(0, "127.0.0.1")
    await listening
    const address = server.address()
    assert(address && typeof address === "object")
    // Deliberate allowlist: provider credentials, caller agent dirs and task/session env never inherit.
    const env = {
      PATH: process.env.PATH, HOME: sandbox.homeDir, USERPROFILE: sandbox.homeDir,
      TMPDIR: sandbox.root, XDG_CONFIG_HOME: sandbox.xdgConfigHome, XDG_DATA_HOME: sandbox.xdgDataHome,
      XDG_CACHE_HOME: sandbox.xdgCacheHome, XDG_STATE_HOME: join(sandbox.root, "state"),
      OMO_CODING_AGENT_DIR: sandbox.agentDir, SENPI_CODING_AGENT_DIR: sandbox.agentDir, PI_CODING_AGENT_DIR: sandbox.agentDir,
      OMO_AGENT_TOOLKIT_BIN: toolkit, OMO_POLICY_QA_TRACE: traceFile, OMO_POLICY_QA_LANE: lane,
      OMO_POLICY_QA_ENDPOINT: `http://127.0.0.1:${address.port}`, PI_OFFLINE: "1", OMO_SENPI_QA: "1",
    }
    child = spawn(process.execPath, [cli, "--mode", "rpc", "--no-extensions", "--no-skills", "--no-prompt-templates",
      "-e", extension, "--provider", "omo-policy-qa", "--model", "qa"], { cwd: sandbox.cwd, env, stdio: "pipe" })
    const bus = new EventEmitter()
    child.stderr.on("data", (data) => { stderr += data })
    child.on("error", (error) => bus.emit("error", error))
    lines = createInterface({ input: child.stdout })
    lines.on("line", (line) => {
      let event
      try { event = JSON.parse(line) } catch (error) { bus.emit("error", error); return }
      events.push(event)
      bus.emit(event.id ? `response:${event.id}` : event.type, event)
    })
    let sequence = 0
    async function request(type, data = {}) {
      const id = `qa-${++sequence}`
      const reply = once(bus, `response:${id}`, { signal: AbortSignal.timeout(30_000) })
      child.stdin.write(`${JSON.stringify({ type, id, ...data })}\n`)
      const [response] = await reply
      assert.equal(response.success, true, JSON.stringify(response))
      return response.data
    }
    async function prompt(message) {
      // Subscribe before submission. agent_idle, unlike agent_end, is after settlement and queue drain.
      const idle = once(bus, "agent_idle", { signal: AbortSignal.timeout(30_000) })
      await Promise.all([idle, request("prompt", { message })])
      const snapshot = trace(traceFile)
      assert.equal(snapshot.at(-1)?.type, "hook_settled")
      assert.equal(snapshot.at(-1)?.pending, 0)
      return snapshot
    }
    await request("get_state")
    const failed = await prompt("Exercise the active QA plan.")
    assert(failed.some((event) => event.type === "loaded"))
    assert(failed.some((event) => event.type === "active_plan" && event.lane === lane))
    assert.equal(calls, 1, "terminal failure must make exactly one provider call")
    assert.equal(failed.filter((event) => event.type === "omo_send").length, 0)
    const end = failed.find((event) => event.type === "hook_end")
    assert.equal(end?.event.willRetry, false)
    if (failure === "policy") {
      assert.equal(end?.event.messages.at(-1).stopReason, "error")
      assert.equal(end.event.messages.at(-1).errorMessage, policyError)
    } else {
      // The real host normalizes empty toolUse into stop but must retain its refusal signal.
      assert.equal(end?.event.messages.at(-1).stopDetails.type, "refusal")
      assert(events.some((event) => event.type === "message_end" && event.message?.stopReason === "toolUse"))
    }
    phase = "clean"
    const recovered = await prompt("Continue after this explicit user input.")
    assert.equal(calls, 3, "clean input must make one automatic continuation, then dedupe")
    const sends = recovered.filter((event) => event.type === "omo_send")
    assert.equal(sends.length, 1)
    assert.equal(sends[0].message.customType, "omo-senpi:wake")
    assert.deepEqual(sends[0].message.details.map((detail) => detail.customType),
      [lane === "loop" ? "omo-senpi:ulw-continuation" : "omo-senpi:ulw-execute-continuation"])
    return { name, result: "PASS", failureCalls: 1, failureSends: 0, totalCalls: calls, cleanSends: sends.length,
      isolatedAgentDir: sandbox.agentDir, coordinator: "production class, default microtask scheduler", get cleanup() { return cleanup } }
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit", { signal: AbortSignal.timeout(10_000) })
      child.kill("SIGTERM")
      await exited
    }
    lines?.close()
    if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    writeFileSync(join(evidence, `${name}-events.jsonl`), events.map((event) => JSON.stringify(event)).join("\n") + "\n")
    writeFileSync(join(evidence, `${name}-stderr.log`), stderr)
    rmSync(sandbox.root, { recursive: true, force: true })
    cleanup = { childTerminal: !child || child.exitCode !== null || child.signalCode !== null, sandboxRemoved: true }
  }
}

try {
  for (const lane of ["loop", "boulder"]) {
    for (const failure of ["policy", "refusal"]) reports.push(await scenario(lane, failure))
  }
} catch (error) {
  reports.push({ result: "FAIL", error: error instanceof Error ? error.stack : String(error) })
  process.exitCode = 1
} finally {
  const after = realHomes.map(credentialDigest)
  const realSenpiUntouched = before.every((digest, index) => digest === after[index])
  if (!realSenpiUntouched) process.exitCode = 1
  const report = { result: process.exitCode ? "FAIL" : "PASS", cli, scenarios: reports, realSenpiUntouched,
    isolationScope: "credential digests for real ~/.senpi/agent and ~/.omo/agent; allowlisted sandbox-only child environment",
    evidence }
  writeFileSync(join(evidence, "live-report.json"), JSON.stringify(report, null, 2) + "\n")
  console.log(JSON.stringify(report, null, 2))
}
