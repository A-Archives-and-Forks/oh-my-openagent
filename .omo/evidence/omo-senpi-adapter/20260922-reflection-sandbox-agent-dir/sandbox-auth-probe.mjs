#!/usr/bin/env bun
// Real-surface probe for omo#8595: renders the production reflection sandbox through the memory
// wiring, then EXECUTES the transformed command under the real seatbelt/bwrap so the credential
// lock the engine performs is exercised for real - in the granted agent dir and in a decoy dir.
//
// Run:  bun .omo/evidence/omo-senpi-adapter/20260922-reflection-sandbox-agent-dir/sandbox-auth-probe.mjs
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { buildIdentityPaths } from "@oh-my-opencode/memory-core"

import { createMemoryIdentityContext } from "../../../../packages/omo-senpi/src/components/memory/context"
import { loadedMemoryConfig, memorySettings } from "../../../../packages/omo-senpi/src/components/memory/memory.test-support"
import { createMemoryRuntimeWiring } from "../../../../packages/omo-senpi/src/components/memory/wiring-runtime"

const root = await mkdtemp(join(tmpdir(), "omo-8595-probe-"))
const paths = buildIdentityPaths(root, "probe-agent")
await Promise.all(
  [paths.repo, paths.transcripts, paths.reflection, paths.reflectionSessions, paths.worktrees].map((path) =>
    mkdir(path, { recursive: true }),
  ),
)

// The directory the ENGINE reports for this session (what ctx.agentDir carries), and a decoy the
// adapter's own detection could have produced instead.
const engineAgentDir = join(root, "engine-agent-dir")
const decoyAgentDir = join(root, "decoy-agent-dir")
await Promise.all([mkdir(engineAgentDir, { recursive: true }), mkdir(decoyAgentDir, { recursive: true })])
await writeFile(join(engineAgentDir, "settings.json"), "{}\n", "utf8")
await writeFile(join(decoyAgentDir, "settings.json"), "{}\n", "utf8")

const probe = join(root, "probe.sh")
await writeFile(
  probe,
  [
    "#!/bin/sh",
    'echo "OMO_CODING_AGENT_DIR=$OMO_CODING_AGENT_DIR"',
    'echo "SENPI_CODING_AGENT_DIR=$SENPI_CODING_AGENT_DIR"',
    'echo "PI_CODING_AGENT_DIR=$PI_CODING_AGENT_DIR"',
    // proper-lockfile takes the credential lock by mkdir'ing "<auth.json>.lock"
    'if mkdir "$OMO_CODING_AGENT_DIR/auth.json.lock" 2>/dev/null; then echo "PINNED_LOCK=ok"; else echo "PINNED_LOCK=denied"; fi',
    'if mkdir "$OMO_8595_DECOY_DIR/auth.json.lock" 2>/dev/null; then echo "DECOY_LOCK=ok"; else echo "DECOY_LOCK=denied"; fi',
    "",
  ].join("\n"),
  "utf8",
)
await chmod(probe, 0o755)

const identity = createMemoryIdentityContext({
  identity: "probe-agent",
  identityPaths: paths,
  binding: { identity: "probe-agent", repoPathHash: "hash", boundAt: 1 },
})

const settings = memorySettings()
const wiring = createMemoryRuntimeWiring(
  {
    sessions: new Map(),
    loadConfig: () => loadedMemoryConfig({ ...settings, reflection: { ...settings.reflection, sandbox: "required" } }),
    cwd: () => root,
    env: {},
  },
  // The host's event context: the engine's OWN answer for this session.
  { current: { agentDir: engineAgentDir } },
)

const runtime = wiring.runtimeFor(identity)
const sandbox = runtime.runner.options.sandbox
const transformed = await sandbox({
  runId: "reflection-run-8595-probe",
  attempt: 1,
  hardDeadlineAt: Date.now() + 30_000,
  category: "quick",
  conversationIds: ["conversation-probe"],
  model: "fixture/model",
  command: probe,
  args: [],
  cwd: paths.worktrees,
  // The parent leaked a stale agent dir, exactly as an inherited environment would.
  env: {
    PATH: process.env.PATH ?? "",
    OMO_CODING_AGENT_DIR: decoyAgentDir,
    SENPI_CODING_AGENT_DIR: decoyAgentDir,
    PI_CODING_AGENT_DIR: decoyAgentDir,
    OMO_8595_DECOY_DIR: decoyAgentDir,
  },
  detached: false,
  paths: {
    sessionDir: paths.reflectionSessions,
    worktree: paths.worktrees,
    gitCommonDir: paths.repo,
    transcript: join(paths.transcripts, "transcript.json"),
    persona: join(paths.reflectionSessions, "persona.md"),
    prompt: join(paths.reflectionSessions, "prompt.md"),
  },
})

const sandboxed = transformed.command !== probe
const run = spawnSync(transformed.command, transformed.args, { env: transformed.env, encoding: "utf8" })
const output = `${run.stdout ?? ""}${run.stderr ?? ""}`.trim()

// Control: the same rendered sandbox WITHOUT the environment pin, i.e. the pre-fix child that
// resolves its own agent dir from an inherited value the sandbox never granted.
const unpinnedEnv = { ...transformed.env }
for (const name of ["OMO_CODING_AGENT_DIR", "SENPI_CODING_AGENT_DIR", "PI_CODING_AGENT_DIR"]) {
  unpinnedEnv[name] = decoyAgentDir
}
const control = spawnSync(transformed.command, transformed.args, { env: unpinnedEnv, encoding: "utf8" })
const controlOutput = `${control.stdout ?? ""}${control.stderr ?? ""}`.trim()

const report = {
  platform: process.platform,
  sandboxed,
  sandboxExecutable: transformed.command,
  engineAgentDir,
  decoyAgentDir,
  childPins: {
    OMO_CODING_AGENT_DIR: transformed.env.OMO_CODING_AGENT_DIR,
    SENPI_CODING_AGENT_DIR: transformed.env.SENPI_CODING_AGENT_DIR,
    PI_CODING_AGENT_DIR: transformed.env.PI_CODING_AGENT_DIR,
  },
  probeExitCode: run.status,
  probeOutput: output.split("\n"),
  controlExitCode: control.status,
  controlOutput: controlOutput.split("\n"),
  verdict: {
    pinsEngineDir: [transformed.env.OMO_CODING_AGENT_DIR, transformed.env.SENPI_CODING_AGENT_DIR, transformed.env.PI_CODING_AGENT_DIR]
      .every((value) => value === engineAgentDir),
    lockedInGrantedDir: output.includes("PINNED_LOCK=ok"),
    deniedOutsideGrant: output.includes("DECOY_LOCK=denied"),
    controlReproducesTheDefect: controlOutput.includes("PINNED_LOCK=denied"),
  },
  tempRoot: root,
}
console.log(JSON.stringify(report, null, 2))
await rm(root, { recursive: true, force: true })
console.log(JSON.stringify({ cleanup: `removed ${root}`, remains: existsSync(root) }, null, 2))
