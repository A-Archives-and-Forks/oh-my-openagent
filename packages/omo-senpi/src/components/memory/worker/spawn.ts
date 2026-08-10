import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { chmod, mkdir, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  loadReflectionPersona,
  type ReflectionWorktree,
  type ReservedRun,
} from "@oh-my-opencode/memory-core"
import { detectBunBinary, resolveSenpiExecutable } from "@oh-my-opencode/senpi-task"

import {
  readRunJson,
  writeRunJsonAtomic,
  type RunLaunchManifest,
  type RunOutcome,
} from "./run-artifacts"

const DEFAULT_GRACE_MS = 5_000
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024

export interface ReflectionSpawnPaths {
  readonly sessionDir: string
  readonly worktree: string
  readonly gitCommonDir: string
  readonly transcript: string
  readonly persona: string
  readonly prompt: string
}

export interface ReflectionSpawnArgs {
  readonly runId?: string
  readonly kind?: "reflection"
  readonly trigger?: ReservedRun["request"]["trigger"]
  readonly mergePolicy?: "auto" | "integration"
  readonly worktree?: ReflectionWorktree
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly detached: true
  readonly paths: ReflectionSpawnPaths
}

export type ReflectionSandbox = (
  spawnArgs: ReflectionSpawnArgs,
) => ReflectionSpawnArgs | Promise<ReflectionSpawnArgs>

export interface ReflectionChildResult {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
}

export async function prepareReflectionSpawn(input: {
  readonly run: ReservedRun
  readonly worktree: ReflectionWorktree
  readonly reflectionSessionsDir: string
  readonly model: string
  readonly thinking?: string
  readonly env: NodeJS.ProcessEnv
  readonly mergePolicy: "auto" | "integration"
  readonly senpiCommand?: string
}): Promise<ReflectionSpawnArgs> {
  const sessionDir = join(input.reflectionSessionsDir, safeRunId(input.run.runId))
  await mkdir(sessionDir, { recursive: true, mode: 0o700 })
  const transcript = join(sessionDir, "transcript-payload.json")
  const persona = join(sessionDir, "reflection-persona.md")
  const prompt = join(sessionDir, "reflection-task.md")
  // Payload files are chmod 0400 after writing, so a reused run directory (retry with the same
  // runId) must relax the mode before rewriting or the open() fails with EACCES.
  await Promise.all([transcript, persona, prompt].map(async (path) => {
    try {
      await chmod(path, 0o600)
    } catch {
      // First run for this runId: nothing to relax.
    }
  }))
  await Promise.all([
    writeFile(transcript, `${JSON.stringify({ schemaVersion: 1, runId: input.run.runId, request: input.run.request }, null, 2)}\n`, "utf8"),
    writeFile(persona, loadReflectionPersona().markdown, "utf8"),
    writeFile(prompt, buildTaskPrompt(input.run, input.worktree.dir, transcript), "utf8"),
  ])
  await Promise.all([transcript, persona, prompt].map((path) => chmod(path, 0o400)))

  const paths = {
    sessionDir,
    worktree: input.worktree.dir,
    gitCommonDir: dirname(input.worktree.commonConfigPath),
    transcript,
    persona,
    prompt,
  }
  const env: NodeJS.ProcessEnv = {
    ...input.env,
    MEMORY_DIR: input.worktree.dir,
    TRANSCRIPT_PATH: transcript,
    SENPI_MEMORY_REFLECTION: "1",
    // A detached child has no controlling terminal, so senpi's PTY-backed bash session fails with
    // "Native PTY session handle is missing write()" and the child could never git-commit its
    // reflection. pi-pty's documented non-interactive override selects the pipe session backend.
    SENPI_PTY_FORCE_PIPE: "1",
  }
  // Verified against senpi packages/coding-agent/src/cli/args.ts and cli/file-processor.ts:
  // -p selects print mode; --system-prompt reads a file path; --tools is a comma allowlist;
  // --no-extensions/--no-skills/--no-prompt-templates/--no-context-files disable discovery;
  // --session-dir isolates JSONL storage; --model/--thinking select the category result; @file
  // loads the mechanics prompt as the initial non-interactive message.
  const args = [
    "-p",
    "--system-prompt", persona,
    "--tools", "bash,edit",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--session-dir", sessionDir,
    "--model", input.model,
    ...(input.thinking === undefined ? [] : ["--thinking", input.thinking]),
    `@${prompt}`,
  ]
  return {
    runId: input.run.runId,
    kind: "reflection",
    trigger: input.run.request.trigger,
    mergePolicy: input.mergePolicy,
    worktree: input.worktree,
    command: input.senpiCommand ?? resolveDefaultSenpiCommand(input.env),
    args,
    cwd: input.worktree.dir,
    env,
    detached: true,
    paths,
  }
}

export async function runReflectionChild(
  spawnArgs: ReflectionSpawnArgs,
  options: {
    readonly deadlineMs: number
    readonly terminationGraceMs?: number
    readonly maxOutputBytes?: number
    readonly sandbox?: ReflectionSandbox
    readonly supervisorPath?: string
    readonly now?: () => number
  },
): Promise<ReflectionChildResult> {
  if (!Number.isFinite(options.deadlineMs) || options.deadlineMs <= 0) {
    throw new TypeError("reflection deadline must be positive")
  }
  const graceMs = options.terminationGraceMs ?? DEFAULT_GRACE_MS
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  if (graceMs < 0 || maxOutputBytes <= 0) throw new TypeError("reflection spawn limits are invalid")

  const prepared = await (options.sandbox ?? passthroughSandbox)(spawnArgs)
  const metadata = requireRunMetadata(prepared)
  await mkdir(prepared.paths.sessionDir, { recursive: true, mode: 0o700 })
  const stdoutPath = join(prepared.paths.sessionDir, "child-stdout.log")
  const stderrPath = join(prepared.paths.sessionDir, "child-stderr.log")
  const launchedAt = (options.now ?? Date.now)()
  const hardDeadlineAt = launchedAt + options.deadlineMs
  const deadlineAt = hardDeadlineAt + graceMs
  const launch: RunLaunchManifest = {
    version: 1,
    runId: metadata.runId,
    kind: metadata.kind,
    command: prepared.command,
    args: [...prepared.args],
    cwd: prepared.cwd,
    env: definedEnvironment(prepared.env),
    hardDeadlineAt,
    terminationGraceMs: graceMs,
    maxOutputBytes,
    stdoutPath,
    stderrPath,
  }
  await writeRunJsonAtomic(join(prepared.paths.sessionDir, "ledger.json"), {
    version: 1,
    runId: metadata.runId,
    kind: metadata.kind,
    trigger: metadata.trigger,
    startedAt: new Date(launchedAt).toISOString(),
    hardDeadlineAt,
    terminationGraceMs: graceMs,
    deadlineAt,
    mergePolicy: metadata.mergePolicy,
    worktreeDir: metadata.worktree.dir,
    worktreeBranch: metadata.worktree.branch,
    baseSha: metadata.worktree.baseSha,
    gitFilePath: metadata.worktree.gitFilePath,
    gitFileSnapshot: metadata.worktree.gitFileSnapshot,
    commonConfigPath: metadata.worktree.commonConfigPath,
    commonConfigSnapshot: metadata.worktree.commonConfigSnapshot,
  })
  await writeRunJsonAtomic(join(prepared.paths.sessionDir, "launch.json"), launch)

  const supervisor = spawn(process.execPath, [options.supervisorPath ?? defaultSupervisorPath(), prepared.paths.sessionDir], {
    detached: true,
    stdio: "ignore",
  })
  supervisor.unref()
  const supervisorExit = await new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>((resolve, reject) => {
    let settled = false
    supervisor.once("error", (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
    supervisor.once("close", (code, signal) => {
      if (settled) return
      settled = true
      resolve({ code, signal })
    })
  })
  if (supervisorExit.code !== 0 || supervisorExit.signal !== null) {
    throw new Error(`memory run supervisor exited with ${supervisorExit.code ?? supervisorExit.signal ?? "unknown status"}`)
  }
  const outcome = await readRunJson<RunOutcome>(join(prepared.paths.sessionDir, "outcome.json"))
  return {
    code: outcome.childExit.code,
    signal: isNodeSignal(outcome.childExit.signal) ? outcome.childExit.signal : null,
    stdout: readTail(stdoutPath, maxOutputBytes),
    stderr: readTail(stderrPath, maxOutputBytes),
    timedOut: outcome.timedOut,
  }
}

function requireRunMetadata(spawnArgs: ReflectionSpawnArgs): {
  readonly runId: string
  readonly kind: "reflection"
  readonly trigger: ReservedRun["request"]["trigger"]
  readonly mergePolicy: "auto" | "integration"
  readonly worktree: ReflectionWorktree
} {
  const { runId, kind, trigger, mergePolicy, worktree } = spawnArgs
  if (runId === undefined || kind === undefined || trigger === undefined || mergePolicy === undefined || worktree === undefined) {
    throw new TypeError("reflection spawn metadata is required")
  }
  return { runId, kind, trigger, mergePolicy, worktree }
}

function passthroughSandbox(spawnArgs: ReflectionSpawnArgs): ReflectionSpawnArgs {
  return spawnArgs
}

function buildTaskPrompt(run: ReservedRun, worktree: string, transcript: string): string {
  const focus = run.request.focus ? `\nFocus: ${run.request.focus}` : ""
  return [
    "# Reflection mechanics",
    `MEMORY_DIR=${worktree}`,
    `TRANSCRIPT_PATH=${transcript}`,
    "Read the transcript payload, update only files under MEMORY_DIR, and commit every intended memory change.",
    "Do not modify Git administration files. Finish with a clean worktree.",
    `Trigger: ${run.request.trigger}${focus}`,
  ].join("\n")
}

function resolveDefaultSenpiCommand(env: NodeJS.ProcessEnv): string {
  return resolveSenpiExecutable({
    isBunBinary: detectBunBinary(import.meta.url),
    execPath: process.execPath,
    platform: process.platform,
    parentEnv: env,
    resolveRpcEntry: () => "",
  }) ?? "senpi"
}

function safeRunId(runId: string): string {
  const safe = basename(runId.trim()).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")
  if (!safe || safe === "." || safe === "..") throw new TypeError("runId must contain a safe identifier")
  return safe.slice(0, 80)
}

function definedEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined))
}

function defaultSupervisorPath(): string {
  return fileURLToPath(new URL("./memory-run-supervisor.mjs", import.meta.url))
}

const NODE_SIGNALS = new Set<NodeJS.Signals>([
  "SIGABRT", "SIGALRM", "SIGBUS", "SIGCHLD", "SIGCONT", "SIGFPE", "SIGHUP", "SIGILL",
  "SIGINT", "SIGIO", "SIGIOT", "SIGKILL", "SIGPIPE", "SIGPOLL", "SIGPROF", "SIGPWR",
  "SIGQUIT", "SIGSEGV", "SIGSTKFLT", "SIGSTOP", "SIGSYS", "SIGTERM", "SIGTRAP", "SIGTSTP",
  "SIGTTIN", "SIGTTOU", "SIGURG", "SIGUSR1", "SIGUSR2", "SIGVTALRM", "SIGWINCH", "SIGXCPU",
  "SIGXFSZ",
])

function isNodeSignal(signal: string | null): signal is NodeJS.Signals {
  return signal !== null && NODE_SIGNALS.has(signal as NodeJS.Signals)
}

function readTail(path: string, maxBytes: number): string {
  try {
    const content = readFileSync(path, "utf8")
    if (Buffer.byteLength(content, "utf8") <= maxBytes) return content
    return `[truncated to last ${maxBytes} bytes]\n${content.slice(-maxBytes)}`
  } catch (error) {
    return error instanceof Error ? `[failed to read child output: ${error.message}]` : "[failed to read child output]"
  }
}
