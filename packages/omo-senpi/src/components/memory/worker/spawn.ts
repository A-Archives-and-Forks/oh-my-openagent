import { spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { chmod, mkdir, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  loadFactsPersona,
  loadReflectionPersona,
  type FactsPayload,
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

export interface FactsSpawnArgs {
  readonly runId: string
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly detached: true
  readonly paths: {
    readonly runDir: string
    readonly payload: string
    readonly extraction: string
  }
}

export interface FactsRunLedgerEnvelope {
  readonly version: 1
  readonly runId: string
  readonly kind: "facts"
  readonly startedAt: string
  readonly hardDeadlineAt: number
  readonly terminationGraceMs: number
  readonly deadlineAt: number
  readonly batchId: string
  readonly queued: readonly { readonly conversationId: string; readonly end_message_id: string }[]
  readonly headBeforeApply?: string
}

export type FactsSandbox = (spawnArgs: FactsSpawnArgs) => FactsSpawnArgs | Promise<FactsSpawnArgs>

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

export async function prepareFactsSpawn(input: {
  readonly runId: string
  readonly runDir: string
  readonly payload: FactsPayload
  readonly model: string
  readonly thinking?: string
  readonly env: NodeJS.ProcessEnv
  readonly senpiCommand?: string
}): Promise<FactsSpawnArgs> {
  await mkdir(input.runDir, { recursive: true, mode: 0o700 })
  const payload = join(input.runDir, "facts-payload.json")
  const extraction = join(input.runDir, "extraction.jsonl")
  try {
    await chmod(payload, 0o600)
  } catch {
    // The first launch has no payload to relax.
  }
  await writeFile(payload, `${JSON.stringify(input.payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
  await chmod(payload, 0o400)
  const env: NodeJS.ProcessEnv = {
    ...input.env,
    FACTS_PAYLOAD_PATH: payload,
    FACTS_EXTRACTION_PATH: extraction,
    SENPI_MEMORY_FACTS: "1",
    SENPI_PTY_FORCE_PIPE: "1",
  }
  const args = [
    "-p",
    "--system-prompt", loadFactsPersona(),
    "--tools", "read,write",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--session-dir", input.runDir,
    "--model", input.model,
    ...(input.thinking === undefined ? [] : ["--thinking", input.thinking]),
    `Read ${payload} and write only ${extraction} according to the system prompt.`,
  ]
  return {
    runId: input.runId,
    command: input.senpiCommand ?? resolveDefaultSenpiCommand(input.env),
    args,
    cwd: input.runDir,
    env,
    detached: true,
    paths: { runDir: input.runDir, payload, extraction },
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
  const launchedAt = (options.now ?? Date.now)()
  const hardDeadlineAt = launchedAt + options.deadlineMs
  return runSupervisedChild({
    runDir: prepared.paths.sessionDir,
    runId: metadata.runId,
    kind: metadata.kind,
    command: prepared.command,
    args: prepared.args,
    cwd: prepared.cwd,
    env: prepared.env,
    hardDeadlineAt,
    terminationGraceMs: graceMs,
    maxOutputBytes,
    supervisorPath: options.supervisorPath,
    ledger: {
      version: 1,
      runId: metadata.runId,
      kind: metadata.kind,
      trigger: metadata.trigger,
      startedAt: new Date(launchedAt).toISOString(),
      hardDeadlineAt,
      terminationGraceMs: graceMs,
      deadlineAt: hardDeadlineAt + graceMs,
      mergePolicy: metadata.mergePolicy,
      worktreeDir: metadata.worktree.dir,
      worktreeBranch: metadata.worktree.branch,
      baseSha: metadata.worktree.baseSha,
      gitFilePath: metadata.worktree.gitFilePath,
      gitFileSnapshot: metadata.worktree.gitFileSnapshot,
      commonConfigPath: metadata.worktree.commonConfigPath,
      commonConfigSnapshot: metadata.worktree.commonConfigSnapshot,
    },
  })
}

export async function runFactsChild(
  spawnArgs: FactsSpawnArgs,
  options: {
    readonly deadlineMs: number
    readonly terminationGraceMs?: number
    readonly maxOutputBytes?: number
    readonly sandbox?: FactsSandbox
    readonly supervisorPath?: string
    readonly now?: () => number
    readonly batchId: string
    readonly queued: readonly { readonly conversationId: string; readonly end_message_id: string }[]
  },
): Promise<ReflectionChildResult> {
  if (!Number.isFinite(options.deadlineMs) || options.deadlineMs <= 0) {
    throw new TypeError("facts deadline must be positive")
  }
  const graceMs = options.terminationGraceMs ?? DEFAULT_GRACE_MS
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  if (graceMs < 0 || maxOutputBytes <= 0) throw new TypeError("facts spawn limits are invalid")
  const prepared = await (options.sandbox ?? passthroughFactsSandbox)(spawnArgs)
  const launchedAt = (options.now ?? Date.now)()
  const hardDeadlineAt = launchedAt + options.deadlineMs
  return runSupervisedChild({
    runDir: prepared.paths.runDir,
    runId: prepared.runId,
    kind: "facts",
    command: prepared.command,
    args: prepared.args,
    cwd: prepared.cwd,
    env: prepared.env,
    hardDeadlineAt,
    terminationGraceMs: graceMs,
    maxOutputBytes,
    supervisorPath: options.supervisorPath,
    ledger: {
      version: 1,
      runId: prepared.runId,
      kind: "facts",
      startedAt: new Date(launchedAt).toISOString(),
      hardDeadlineAt,
      terminationGraceMs: graceMs,
      deadlineAt: hardDeadlineAt + graceMs,
      batchId: options.batchId,
      queued: options.queued,
    } satisfies FactsRunLedgerEnvelope,
  })
}

async function runSupervisedChild(input: {
  readonly runDir: string
  readonly runId: string
  readonly kind: "reflection" | "facts"
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly hardDeadlineAt: number
  readonly terminationGraceMs: number
  readonly maxOutputBytes: number
  readonly supervisorPath?: string
  readonly ledger: Readonly<Record<string, unknown>>
}): Promise<ReflectionChildResult> {
  await mkdir(input.runDir, { recursive: true, mode: 0o700 })
  const stdoutPath = join(input.runDir, "child-stdout.log")
  const stderrPath = join(input.runDir, "child-stderr.log")
  const launch: RunLaunchManifest = {
    version: 1,
    runId: input.runId,
    kind: input.kind,
    command: input.command,
    args: [...input.args],
    cwd: input.cwd,
    env: definedEnvironment(input.env),
    hardDeadlineAt: input.hardDeadlineAt,
    terminationGraceMs: input.terminationGraceMs,
    maxOutputBytes: input.maxOutputBytes,
    stdoutPath,
    stderrPath,
  }
  await writeRunJsonAtomic(join(input.runDir, "ledger.json"), input.ledger)
  await writeRunJsonAtomic(join(input.runDir, "launch.json"), launch)

  const supervisor = spawn(process.execPath, [input.supervisorPath ?? defaultSupervisorPath(), input.runDir], {
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
  const outcome = await readRunJson<RunOutcome>(join(input.runDir, "outcome.json"))
  return {
    code: outcome.childExit.code,
    signal: isNodeSignal(outcome.childExit.signal) ? outcome.childExit.signal : null,
    stdout: readTail(stdoutPath, input.maxOutputBytes),
    stderr: readTail(stderrPath, input.maxOutputBytes),
    timedOut: outcome.timedOut,
  }
}

function requireRunMetadata(spawnArgs: ReflectionSpawnArgs): {
  readonly runId: string
  readonly kind: "reflection" | "dream"
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

function passthroughFactsSandbox(spawnArgs: FactsSpawnArgs): FactsSpawnArgs {
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
  const override = process.env.OMO_MEMORY_RUN_SUPERVISOR_PATH
  if (override !== undefined && override.trim().length > 0) return override
  const bundled = fileURLToPath(new URL("./memory-run-supervisor.mjs", import.meta.url))
  if (existsSync(bundled)) return bundled
  return fileURLToPath(new URL("./memory-run-supervisor.ts", import.meta.url))
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
