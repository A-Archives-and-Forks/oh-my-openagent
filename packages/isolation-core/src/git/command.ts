import { spawn, type ChildProcess } from "node:child_process"
import type { Readable } from "node:stream"
import { lstat } from "node:fs/promises"
import { IsolationUnavailableError } from "../backend"

export async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false
    throw error
  }
}

export class GitCommandError extends Error {
  constructor(readonly args: readonly string[], readonly cwd: string, readonly exitCode: number, readonly stderr: string) {
    super(`git ${args.join(" ")} failed (${exitCode}): ${stderr}`)
    this.name = "GitCommandError"
  }
}
export interface GitOptions {
  cwd: string
  env?: Record<string, string | undefined>
  signal?: AbortSignal
  input?: string | Buffer
  allowedExitCodes?: readonly number[]
  maxOutputBytes?: number
  outputLimitError?: () => Error
  /** Observes the spawned process (tests use it to signal git by pid). */
  onSpawn?: (child: ChildProcess) => void
}

// git runs "!" aliases and hooks through a shell, so its helpers are
// grandchildren. Killing only the direct child leaves them writing into the
// inherited pipes; on POSIX the child leads its own process group so the whole
// tree goes down together. win32 has no process groups: the alias shell and
// its writers survive a direct kill, keep the drained pipes open and hold
// their working directory, so the whole spawned tree is terminated instead.
function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform !== "win32") {
    // POSIX: the child leads its own process group; a group that already died
    // leaves nothing worth killing, so the ESRCH fall-through is a plain kill.
    try { process.kill(-child.pid, "SIGKILL"); return } catch { try { child.kill("SIGKILL") } catch { /* already exited */ } }
    return
  }
  const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
  killer.once("error", () => { try { child.kill("SIGKILL") } catch { /* already exited */ } })
}

/** Drain both pipes concurrently; reject before retaining output beyond the budget. */
export async function runGit(args: string[], options: GitOptions): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  options.signal?.throwIfAborted()
  let child
  try {
    child = spawn("git", args, {
      cwd: options.cwd, env: { ...process.env, ...options.env },
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      signal: options.signal,
      detached: process.platform !== "win32",
    })
    options.onSpawn?.(child)
    if (options.input !== undefined) {
      child.stdin!.end(typeof options.input === "string" ? options.input : new Uint8Array(options.input))
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") throw new IsolationUnavailableError("git not on PATH")
    throw error
  }
  // A child that dies mid-write must surface as a failure, not an EPIPE crash.
  child.stdin?.on("error", () => killTree(child))
  // Drain both pipes concurrently; reject before retaining output beyond the budget.
  let retained = 0
  const collect = (stream: Readable): Promise<Buffer> => new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    stream.on("data", (chunk: Buffer) => {
      retained += chunk.byteLength
      if (retained > (options.maxOutputBytes ?? Infinity)) {
        reject(options.outputLimitError?.() ?? new Error("Git output exceeds budget"))
        killTree(child)
        // A grandchild may hold the pipe open past the kill; stop waiting on "end".
        child.stdout?.destroy()
        child.stderr?.destroy()
        return
      }
      chunks.push(chunk)
    })
    stream.on("error", reject)
    stream.on("end", () => resolve(Buffer.concat(chunks)))
  })
  const exited = new Promise<number>((resolve, reject) => {
    // Node reports a missing executable through the async "error" event, so the
    // spawn try/catch above cannot see it; classify it here.
    child.once("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return reject(new IsolationUnavailableError("git not on PATH"))
      reject(error)
    })
    child.once("close", (code, signal) => {
      // A signal death leaves exitCode null; "null ?? 0" would report success
      // for a killed git and its partial output.
      if (signal !== null) return reject(new GitCommandError(args, options.cwd, 128, `git terminated by signal ${signal}`))
      resolve(code ?? 0)
    })
  })
  try {
    const [stdout, stderr, code] = await Promise.all([collect(child.stdout!), collect(child.stderr!), exited])
    options.signal?.throwIfAborted()
    if (!(options.allowedExitCodes ?? [0]).includes(code)) throw new GitCommandError(args, options.cwd, code, stderr.toString())
    return { code, stdout, stderr: stderr.toString() }
  } catch (error) {
    killTree(child)
    child.stdout?.destroy()
    child.stderr?.destroy()
    // The teardown kill itself makes `exited` reject with a signal death; that
    // rejection must not displace the caller's error (the typed budget error,
    // for one) on its way out.
    await exited.catch(() => {})
    throw error
  }
}

// Compatibility for the backend/detachment plumbing, all using the same runner.
export function gitResult(cwd: string, args: string[], input?: Buffer) {
  return runGit(args, { cwd, input, allowedExitCodes: Array.from({ length: 256 }, (_, code) => code) })
}
export async function git(cwd: string, args: string[], input?: Buffer): Promise<Buffer> {
  return (await runGit(args, { cwd, input })).stdout
}
