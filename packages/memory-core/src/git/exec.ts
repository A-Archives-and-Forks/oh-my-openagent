import { spawn } from "node:child_process"
import { GitNotFoundError, GitTimeoutError } from "./errors"

export interface GitExecOptions {
  cwd: string
  timeoutMs: number
  env?: NodeJS.ProcessEnv
}

export interface GitExecResult {
  code: number
  stdout: string
  stderr: string
}

export interface GitExec {
  run(argv: readonly string[], options: GitExecOptions): Promise<GitExecResult>
}

export function createNodeGitExec(): GitExec {
  return {
    run(argv, options) {
      return new Promise((resolve, reject) => {
        const child = spawn("git", [...argv], {
          cwd: options.cwd,
          env: options.env ?? process.env,
          stdio: ["ignore", "pipe", "pipe"],
        })
        const stdout: Buffer[] = []
        const stderr: Buffer[] = []
        let settled = false
        let timedOut = false

        const timer = setTimeout(() => {
          timedOut = true
          child.kill("SIGKILL")
        }, options.timeoutMs)

        child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk))
        child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk))
        child.on("error", (error: NodeJS.ErrnoException) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (error.code === "ENOENT") reject(new GitNotFoundError({ cause: error }))
          else reject(error)
        })
        child.on("close", (code) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (timedOut) {
            reject(new GitTimeoutError(argv, options.timeoutMs))
            return
          }
          resolve({
            code: code ?? 1,
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
          })
        })
      })
    },
  }
}
