import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { GitMemoryRepo } from "../git"
import { runMemoryApplyPatch, type MemoryApplyPatchParams } from "./memory-apply-patch"

export const author = { agentId: "patch-agent", authorName: "Patch Agent", authorEmail: "patch@example.test" }

export function createPatchFixtureHarness() {
  const tempDirs: string[] = []

  async function fixture(seedFiles: Record<string, string> = {}) {
    const root = await mkdtemp(join(tmpdir(), "memory-apply-patch-"))
    tempDirs.push(root)
    const dir = join(root, "memory")
    const repo = new GitMemoryRepo({ dir, agentId: author.agentId })
    await repo.init({ authorName: author.authorName })
    const paths = Object.keys(seedFiles)
    for (const [path, content] of Object.entries(seedFiles)) {
      await mkdir(dirname(join(dir, path)), { recursive: true })
      await writeFile(join(dir, path), content)
    }
    if (paths.length > 0) await repo.commitWrite(paths, "seed", author)
    return { root, dir, repo, locksDirectory: join(root, "locks") }
  }

  async function cleanup(): Promise<void> {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  }

  return { fixture, cleanup }
}

export function params(_locksDirectory: string, reason: string, input: string): MemoryApplyPatchParams {
  return { reason, input, author }
}

export async function memoryApplyPatch(repo: GitMemoryRepo, patchParams: MemoryApplyPatchParams) {
  return runMemoryApplyPatch({ repo, params: patchParams, lock: async (_domain, operation) => operation() })
}

export async function rejected(operation: Promise<unknown>): Promise<Error> {
  try {
    await operation
  } catch (error) {
    if (error instanceof Error) return error
    throw new Error(String(error))
  }
  throw new Error("expected operation to reject")
}

export async function git(dir: string, args: readonly string[]): Promise<string> {
  const process = Bun.spawn(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" })
  const stdout = await new Response(process.stdout).text()
  const stderr = await new Response(process.stderr).text()
  const exitCode = await process.exited
  if (exitCode !== 0) throw new Error(stderr.trim())
  return stdout.trimEnd()
}
