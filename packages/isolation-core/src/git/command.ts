import { spawn } from "node:child_process"
import { lstat } from "node:fs/promises"
import { IsolationUnavailableError } from "../backend"

export async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false
    throw error
  }
}

export function gitResult(cwd: string, args: string[], input?: Buffer): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", cwd, ...args], { stdio: ["pipe", "pipe", "pipe"] })
    const stdout: Buffer[] = [], stderr: Buffer[] = []
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk))
    child.on("error", (error: NodeJS.ErrnoException) => reject(error.code === "ENOENT"
      ? new IsolationUnavailableError("git not on PATH") : error))
    child.stdin.on("error", (error: NodeJS.ErrnoException) => { if (error.code !== "EPIPE") reject(error) })
    child.on("close", code => resolve({ code: code ?? -1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString() }))
    child.stdin.end(input)
  })
}

export async function git(cwd: string, args: string[], input?: Buffer): Promise<Buffer> {
  const result = await gitResult(cwd, args, input)
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed (${result.code}): ${result.stderr}`)
  return result.stdout
}
