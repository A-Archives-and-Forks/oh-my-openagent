import { mkdir, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve, sep } from "node:path"
import { acquireLock, releaseLock } from "../../../memory-core/src/locks/acquire"
import { createLockRecord } from "../../../memory-core/src/locks/lock-record"
import { GitCommandError, runGit } from "../git/command"
import type { DeltaPatchResult } from "../git/delta"
import { parseDiffGitLinePaths } from "../git/synthetic-tree"

export type MergeKind = "applied" | "already-applied" | "not-applied" | "branch-merged" | "branch-merge-failed" | "no-changes" | "retained"
export interface MergeState {
  changes_applied: boolean
  kind: MergeKind
  partial?: boolean
  nested_failed?: { path: string; error: string }[]
  branch_name?: string
  conflict?: string
  manual_command?: string
  warning?: string
}
export interface IsolationMergeResult extends MergeState {
  patch_path?: string
  nested_patch_paths?: string[]
  summary_path: string
  files_changed: number
}
export type LockHook = (event: "waiting" | "acquired" | "released", path: string) => void | Promise<void>
export interface ArtifactOptions { id: string; artifactsDir: string; lockHook?: LockHook }
export function errorText(error: unknown): string {
  return error instanceof GitCommandError ? error.stderr : error instanceof Error ? error.message : String(error)
}
export function taskBranch(id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || id.includes("..") || id.endsWith(".") || id.endsWith(".lock")) throw new Error("Invalid isolation task id")
  return `omo/task/${id}`
}
export function nestedPath(root: string, relativePath: string): string {
  const path = resolve(root, relativePath)
  if (isAbsolute(relativePath) || !path.startsWith(resolve(root) + sep)) throw new Error(`Invalid nested repository path: ${relativePath}`)
  return path
}

// Queue in-process callers without polling; the identity-bearing file lock also fences
// other processes and all linked worktrees sharing the same Git object/ref database.
const queues = new Map<string, Promise<void>>()
export async function withRepoLock<T>(repoRoot: string, fn: () => Promise<T>, hook?: LockHook): Promise<T> {
  const commonDir = (await runGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: repoRoot })).stdout.toString().trim()
  const path = join(commonDir, "omo-isolation-merge.lock")
  const previous = queues.get(path) ?? Promise.resolve()
  const turn = Promise.withResolvers<void>()
  const tail = previous.then(() => turn.promise)
  queues.set(path, tail)
  try {
    await hook?.("waiting", path)
    await previous
    const record = await createLockRecord("omo-isolation-merge")
    await acquireLock(path, record, { waitTimeoutMs: 60_000 })
    try {
      await hook?.("acquired", path)
      return await fn()
    } finally {
      await releaseLock(path, record)
      await hook?.("released", path)
    }
  } finally {
    turn.resolve()
    if (queues.get(path) === tail) queues.delete(path)
  }
}
export async function writeArtifacts(delta: DeltaPatchResult, options: ArtifactOptions) {
  taskBranch(options.id)
  const dir = resolve(options.artifactsDir, "isolation", options.id)
  await mkdir(dir, { recursive: true })
  const patch_path = join(dir, "root.patch")
  await writeFile(patch_path, delta.rootPatch)
  const nested_patch_paths: string[] = []
  for (const nested of delta.nestedPatches) {
    const path = nestedPath(join(dir, "nested"), `${nested.relativePath}.patch`)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, nested.patch)
    nested_patch_paths.push(path)
  }
  const files = new Set(delta.rootPatch.split("\n").flatMap(parseDiffGitLinePaths))
  for (const nested of delta.nestedPatches) {
    for (const path of nested.patch.split("\n").flatMap(parseDiffGitLinePaths)) files.add(`${nested.relativePath}/${path}`)
  }
  return { patch_path, nested_patch_paths, summary_path: join(dir, "isolation-summary.md"), files_changed: files.size }
}
export async function summarize(result: IsolationMergeResult): Promise<IsolationMergeResult> {
  await writeFile(result.summary_path, `# Isolation merge: ${result.kind}\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`\n`)
  return result
}
export async function stashPush(repoRoot: string): Promise<boolean> {
  if (!(await runGit(["status", "--porcelain", "--untracked-files=all"], { cwd: repoRoot })).stdout.length) return false
  await runGit(["stash", "push", "--include-untracked", "-m", "omo-task-merge"], { cwd: repoRoot })
  return true
}
export async function stashPop(repoRoot: string): Promise<string | undefined> {
  const result = await runGit(["stash", "pop", "--index"], { cwd: repoRoot, allowedExitCodes: [0, 1] })
  if (result.code) return `stash restore failed; stash entry preserved: ${result.stderr || result.stdout.toString()}`
}
