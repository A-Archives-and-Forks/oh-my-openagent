import { randomUUID } from "node:crypto"
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import type { GitExec, GitExecResult } from "./exec"
import { commandError } from "./repo-arguments"

const GIT_TIMEOUT_MS = 30_000
const INDEX_MODES = new Set<GitIndexMode>(["100644", "100755"])

export type GitIndexMode = "100644" | "100755"

export interface GitIndexIdentity {
  readonly mode: GitIndexMode
  readonly oid: string
}

export interface GitWorktreeFileIdentity {
  readonly kind: "file"
  readonly mode: number
  readonly oid: string
}

export type GitWorktreeIdentity = GitWorktreeFileIdentity | { readonly kind: "missing" }

export interface GitPathState {
  readonly index: GitIndexIdentity | null
  readonly worktree: GitWorktreeIdentity
}

export class GitPathStateError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "GitPathStateError"
  }
}
export class GitPathStateStore {
  constructor(
    private readonly dir: string,
    private readonly exec: GitExec,
  ) {}
  async capture(path: string): Promise<GitPathState> {
    const normalized = normalizeGitPath(path)
    return {
      index: await this.captureIndex(normalized),
      worktree: await this.captureWorktree(normalized),
    }
  }
  async captureAll(paths: readonly string[]): Promise<ReadonlyMap<string, GitPathState>> {
    const normalized = [...new Set(paths.map(normalizeGitPath))]
    const states = await Promise.all(normalized.map(async (path) => [path, await this.capture(path)] as const))
    return new Map(states)
  }
  async hashWorktreeBlob(content: string | Buffer, write = false): Promise<string> {
    return this.hashBlob([...(write ? ["-w"] : []), "--no-filters", "--stdin"], content)
  }

  async hashIndexBlob(path: string, content: string | Buffer, write = false): Promise<string> {
    const normalized = normalizeGitPath(path)
    return this.hashBlob([...(write ? ["-w"] : []), `--path=${normalized}`, "--stdin"], content)
  }

  async readBlob(oid: string): Promise<string> {
    assertOid(oid)
    return (await this.git(["cat-file", "blob", oid])).stdout
  }

  async setIndex(path: string, identity: GitIndexIdentity): Promise<void> {
    const normalized = normalizeGitPath(path)
    assertIndexIdentity(identity)
    await this.git(["update-index", "--add", "--cacheinfo", identity.mode, identity.oid, normalized])
  }

  async removeIndex(path: string): Promise<void> {
    const normalized = normalizeGitPath(path)
    await this.git(["update-index", "--force-remove", "--", normalized])
  }

  async writeWorktree(path: string, identity: GitWorktreeFileIdentity): Promise<void> {
    const normalized = normalizeGitPath(path)
    assertWorktreeIdentity(identity)
    const target = join(this.dir, normalized)
    await assertSafeParents(this.dir, normalized)
    await assertReplaceableTarget(target)
    await mkdir(dirname(target), { recursive: true })
    await assertSafeParents(this.dir, normalized)
    await writeFileAtomic(target, await this.readBlob(identity.oid), identity.mode)
  }

  async removeWorktree(path: string): Promise<void> {
    const normalized = normalizeGitPath(path)
    const target = join(this.dir, normalized)
    await assertSafeParents(this.dir, normalized)
    let stat
    try {
      stat = await lstat(target)
    } catch (error) {
      if (errorCode(error) === "ENOENT") return
      throw error
    }
    if (!stat.isFile()) throw unsupportedWorktree(path, stat.isSymbolicLink() ? "symlink" : "non-file")
    await rm(target)
    await syncDirectory(dirname(target))
  }

  private async captureIndex(path: string): Promise<GitIndexIdentity | null> {
    const output = (await this.git(["--literal-pathspecs", "ls-files", "--stage", "-z", "--", path])).stdout
    const records = output.split("\0").filter(Boolean)
    if (records.length === 0) return null
    const parsed = records.map(parseIndexRecord)
    if (parsed.some((record) => record.stage !== "0")) {
      throw new GitPathStateError(`Git path is unmerged and cannot be recovered safely: ${path}`)
    }
    if (parsed.length !== 1 || parsed[0]?.path !== path) {
      throw new GitPathStateError(`Git path did not resolve to one stage-zero index entry: ${path}`)
    }
    const record = parsed[0]
    if (!INDEX_MODES.has(record.mode as GitIndexMode)) {
      throw new GitPathStateError(`Unsupported Git index mode ${record.mode} for path: ${path}`)
    }
    return { mode: record.mode as GitIndexMode, oid: record.oid }
  }

  private async captureWorktree(path: string): Promise<GitWorktreeIdentity> {
    await assertSafeParents(this.dir, path)
    const fullPath = join(this.dir, path)
    let stat
    try {
      stat = await lstat(fullPath)
    } catch (error) {
      if (errorCode(error) === "ENOENT") return { kind: "missing" }
      throw error
    }
    if (!stat.isFile()) throw unsupportedWorktree(path, stat.isSymbolicLink() ? "symlink" : "non-file")
    const oid = await this.hashWorktreeBlob(await readFile(fullPath), true)
    return { kind: "file", mode: stat.mode & 0o777, oid }
  }

  private async hashBlob(argv: readonly string[], content: string | Buffer): Promise<string> {
    const result = await this.git(["hash-object", ...argv], content)
    const oid = result.stdout.trim()
    assertOid(oid)
    return oid
  }

  private async git(argv: readonly string[], stdin?: string | Buffer): Promise<GitExecResult> {
    const result = await this.exec.run(argv, {
      cwd: this.dir,
      timeoutMs: GIT_TIMEOUT_MS,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      ...(stdin === undefined ? {} : { stdin }),
    })
    if (result.code !== 0) throw commandError(argv, result)
    return result
  }
}

function normalizeGitPath(path: string): string {
  const normalized = path.replace(/\\/g, "/")
  const segments = normalized.split("/")
  if (!normalized || normalized.includes("\0") || normalized.startsWith("/")
    || /^[A-Za-z]:\//.test(normalized)
    || segments.some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) {
    throw new GitPathStateError(`Invalid repository-relative Git path: ${path}`)
  }
  return normalized
}

function parseIndexRecord(record: string) {
  const match = /^(\d{6}) ([0-9a-f]+) ([0-3])\t([\s\S]+)$/.exec(record)
  if (match === null) throw new GitPathStateError("Git returned a malformed index entry")
  return { mode: match[1]!, oid: match[2]!, stage: match[3]!, path: match[4]! }
}

function assertOid(oid: string): void {
  if (!/^[0-9a-f]+$/.test(oid)) throw new GitPathStateError(`Invalid Git object ID: ${oid}`)
}

function assertIndexIdentity(identity: GitIndexIdentity): void {
  if (!INDEX_MODES.has(identity.mode)) throw new GitPathStateError(`Unsupported Git index mode: ${identity.mode}`)
  assertOid(identity.oid)
}

function assertWorktreeIdentity(identity: GitWorktreeFileIdentity): void {
  if (identity.kind !== "file" || !Number.isInteger(identity.mode) || identity.mode < 0 || identity.mode > 0o777) {
    throw new GitPathStateError("Invalid worktree file identity")
  }
  assertOid(identity.oid)
}

async function assertSafeParents(root: string, path: string): Promise<void> {
  const parts = path.split("/").slice(0, -1)
  let current = root
  for (const part of parts) {
    current = join(current, part)
    try {
      const stat = await lstat(current)
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw unsupportedWorktree(path, "unsafe parent")
    } catch (error) {
      if (errorCode(error) === "ENOENT") return
      throw error
    }
  }
}

async function assertReplaceableTarget(path: string): Promise<void> {
  try {
    const stat = await lstat(path)
    if (!stat.isFile()) throw unsupportedWorktree(path, stat.isSymbolicLink() ? "symlink" : "non-file")
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error
  }
}

async function writeFileAtomic(path: string, content: string, mode: number): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.omo-${process.pid}-${randomUUID()}`)
  const file = await open(temporary, "wx", mode)
  try {
    await file.writeFile(content, "utf8")
    await chmod(temporary, mode)
    await file.sync()
  } catch (error) {
    await file.close()
    await rm(temporary, { force: true })
    throw error
  }
  await file.close()
  await rename(temporary, path)
  await syncDirectory(dirname(path))
}

async function syncDirectory(path: string): Promise<void> {
  try {
    const directory = await open(path, "r")
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  } catch (error) {
    if (process.platform !== "win32" || !["EISDIR", "EPERM", "EACCES", "EINVAL"].includes(errorCode(error) ?? "")) throw error
  }
}

function unsupportedWorktree(path: string, kind: string): GitPathStateError {
  return new GitPathStateError(`Unsupported worktree ${kind} at path: ${path}`)
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined
}
