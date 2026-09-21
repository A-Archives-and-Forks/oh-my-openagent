import { spawn } from "node:child_process"
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
    })
    if (options.input !== undefined) {
      child.stdin!.end(typeof options.input === "string" ? options.input : new Uint8Array(options.input))
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") throw new IsolationUnavailableError("git not on PATH")
    throw error
  }
  // Drain both pipes concurrently; reject before retaining output beyond the budget.
  const collect = (stream: Readable): Promise<Buffer> => new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let retained = 0
    stream.on("data", (chunk: Buffer) => {
      retained += chunk.byteLength
      if (retained > (options.maxOutputBytes ?? Infinity)) {
        reject(options.outputLimitError?.() ?? new Error("Git output exceeds budget"))
        child.kill()
        return
      }
      chunks.push(chunk)
    })
    stream.on("error", reject)
    stream.on("end", () => resolve(Buffer.concat(chunks)))
  })
  const exited = new Promise<number>((resolve, reject) => {
    child.once("error", reject)
    child.once("close", () => resolve(child.exitCode ?? 0))
  })
  try {
    const [stdout, stderr, code] = await Promise.all([collect(child.stdout!), collect(child.stderr!), exited])
    options.signal?.throwIfAborted()
    if (!(options.allowedExitCodes ?? [0]).includes(code)) throw new GitCommandError(args, options.cwd, code, stderr.toString())
    return { code, stdout, stderr: stderr.toString() }
  } catch (error) {
    child.kill()
    await exited
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
