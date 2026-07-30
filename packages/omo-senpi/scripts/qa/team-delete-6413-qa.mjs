#!/usr/bin/env node
// Real-process QA for issue 6413: a completed team member keeps a live wrapper process, and
// team_delete must destroy that resident (wrapper + descendants) while ordinary terminal
// cancellation stays a noop. The mock lead creates a one-member team, waits for the member to
// reach completed, records the wrapper PID + descendants, calls team_delete, and then verifies
// every recorded PID is gone BEFORE the lead session exits (so session-shutdown teardown cannot
// mask whether deletion owned the cleanup).

import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { createSandbox, seedSandbox } from "./drive.mjs"
import { startSenpiRun } from "./team-e2e-runtime.mjs"
import { parseEvents } from "./team-e2e-support.mjs"

const scriptDir = dirname(fileURLToPath(import.meta.url))
const mockProviderEntry = join(scriptDir, "team-e2e-mock-provider.ts")
const senpiBin = process.env.SENPI_BIN ?? "senpi"

const QA_OMO_CONFIG = {
  categories: {
    quick: { model: "omo-mock/mock-1" },
  },
}

const WAIT_MEMBER_SOURCE = `import { execFileSync } from "node:child_process"
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const dir = join(process.cwd(), ".omo", "senpi-task", "tasks")
const deadline = Date.now() + 60000

function findCompletedMember() {
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue
    const record = JSON.parse(readFileSync(join(dir, file), "utf8"))
    if (record.status === "completed" && typeof record.pid === "number") return record
  }
  return null
}

function poll() {
  let record = null
  try { record = findCompletedMember() } catch {}
  if (record !== null) {
    let children = []
    try {
      children = execFileSync("pgrep", ["-P", String(record.pid)]).toString().trim().split("\\n").filter(Boolean).map(Number)
    } catch {}
    writeFileSync("member-pids.json", JSON.stringify({ wrapper: record.pid, children }, null, 2))
    console.log(JSON.stringify({ wrapper: record.pid, children }))
    process.exit(0)
  }
  if (Date.now() > deadline) {
    console.error("member never reached completed with a pid")
    process.exit(1)
  }
  setTimeout(poll, 100)
}
poll()
`

const VERIFY_DEAD_SOURCE = `import { readFileSync, writeFileSync } from "node:fs"

const { wrapper, children } = JSON.parse(readFileSync("member-pids.json", "utf8"))
const deadline = Date.now() + 30000

function alive(pid) {
  try { process.kill(pid, 0); return true } catch (error) { return error.code !== "ESRCH" }
}

function poll() {
  const live = [wrapper, ...children].filter(alive)
  if (live.length === 0) {
    writeFileSync("verify-dead.json", JSON.stringify({ wrapper, children, allExited: true }, null, 2))
    console.log(JSON.stringify({ wrapper, children, allExited: true }))
    process.exit(0)
  }
  if (Date.now() > deadline) {
    console.error(JSON.stringify({ wrapper, children, stillAlive: live }))
    process.exit(1)
  }
  setTimeout(poll, 100)
}
poll()
`

const MEMBER_PROMPT = "You are team member 'alpha'. MOCKROLE=quick. Acknowledge, then end your turn."

function buildScript() {
  return {
    lead: [
      {
        type: "tool_call",
        name: "team_create",
        arguments: {
          inline_spec: {
            name: "issue6413",
            members: [{ name: "alpha", kind: "category", category: "quick", prompt: MEMBER_PROMPT }],
          },
        },
      },
      { type: "tool_call", name: "bash", arguments: { command: "node wait-member.mjs" } },
      { type: "tool_call", name: "team_delete", arguments: { team_run_id: "__TEAM_RUN_ID__" } },
      { type: "tool_call", name: "bash", arguments: { command: "node verify-dead.mjs" } },
      { type: "text", text: "issue6413 deleted and verified" },
    ],
    quick: [{ type: "text", text: "alpha acknowledged" }],
  }
}

function assertDead(pid) {
  try {
    process.kill(pid, 0)
    throw new Error(`pid ${pid} still alive after team_delete`)
  } catch (error) {
    if (error.code !== "ESRCH") throw error
  }
}

function main() {
  const evidenceDir = process.argv[2]
  if (evidenceDir === undefined) throw new Error("usage: team-delete-6413-qa.mjs <evidence-dir>")
  mkdirSync(evidenceDir, { recursive: true })

  const sandbox = createSandbox()
  seedSandbox(sandbox)
  mkdirSync(join(sandbox.cwd, ".omo"), { recursive: true })
  writeFileSync(join(sandbox.cwd, ".omo", "omo.json"), `${JSON.stringify(QA_OMO_CONFIG, null, 2)}\n`)
  writeFileSync(join(sandbox.cwd, "wait-member.mjs"), WAIT_MEMBER_SOURCE)
  writeFileSync(join(sandbox.cwd, "verify-dead.mjs"), VERIFY_DEAD_SOURCE)

  const run = startSenpiRun({
    senpiBin,
    sandbox,
    mockProviderEntry,
    parseEvents,
    prompt: "Drive the scripted issue-6413 team_delete verification exactly.",
    script: buildScript(),
  })

  run.completion.then((result) => {
    writeFileSync(join(evidenceDir, "lead.stdout.log"), result.stdout)
    writeFileSync(join(evidenceDir, "lead.stderr.log"), result.stderr)

    const pidsPath = join(sandbox.cwd, "member-pids.json")
    if (!existsSync(pidsPath)) {
      console.error("FAIL: member-pids.json was never written (member did not complete)")
      process.exit(1)
    }
    const { wrapper, children } = JSON.parse(readFileSync(pidsPath, "utf8"))
    writeFileSync(join(evidenceDir, "member-pids.json"), JSON.stringify({ wrapper, children }, null, 2))

    const verifyPath = join(sandbox.cwd, "verify-dead.json")
    if (!existsSync(verifyPath)) {
      console.error(`FAIL: in-turn verification did not pass; run status ${String(result.status)}`)
      process.exit(1)
    }
    writeFileSync(join(evidenceDir, "verify-dead.json"), readFileSync(verifyPath))

    // Driver-side recheck after the lead process exited: wrapper and descendants must stay dead.
    for (const pid of [wrapper, ...children]) assertDead(pid)

    let psRows = ""
    try {
      psRows = execFileSync("ps", ["-p", [wrapper, ...children].join(","), "-o", "pid=,command="]).toString()
    } catch {}
    writeFileSync(join(evidenceDir, "post-delete-ps.txt"), psRows === "" ? "(no matching rows)\n" : psRows)
    if (psRows !== "") throw new Error(`ps rows survived deletion: ${psRows}`)

    const runtimeDir = join(sandbox.cwd, ".omo", "senpi-task", "teams", "runtime")
    const remainingTeams = existsSync(runtimeDir) ? readdirSync(runtimeDir) : []
    writeFileSync(
      join(evidenceDir, "summary.json"),
      `${JSON.stringify({ runStatus: result.status, wrapper, children, allExited: true, remainingTeams }, null, 2)}\n`,
    )
    console.log(JSON.stringify({ pass: true, wrapper, children, remainingTeams }))
  })
}

main()
