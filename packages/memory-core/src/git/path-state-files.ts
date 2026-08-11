import { randomUUID } from "node:crypto"
import { chmod, link, lstat, mkdir, open, rename, rm } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { GitPathStateError } from "./path-state"

export async function writeWorktreeFile(
  root: string,
  path: string,
  content: string,
  mode: number,
  exclusive: boolean,
): Promise<boolean> {
  const target = join(root, path)
  await assertSafeParents(root, path)
  if (!exclusive) await assertReplaceableTarget(target)
  await mkdir(dirname(target), { recursive: true })
  await assertSafeParents(root, path)
  const temporary = join(dirname(target), `.${basename(target)}.omo-${process.pid}-${randomUUID()}`)
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
  if (exclusive) {
    try {
      await link(temporary, target)
    } catch (error) {
      await rm(temporary, { force: true })
      if (errorCode(error) === "EEXIST") return false
      throw error
    }
    await rm(temporary)
  } else {
    await rename(temporary, target)
  }
  await syncDirectory(dirname(target))
  return true
}

export async function removeWorktreeFile(root: string, path: string): Promise<void> {
  const target = join(root, path)
  await assertSafeParents(root, path)
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

export async function assertSafeParents(root: string, path: string): Promise<void> {
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

export function unsupportedWorktree(path: string, kind: string): GitPathStateError {
  return new GitPathStateError(`Unsupported worktree ${kind} at path: ${path}`)
}

export function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined
}

async function assertReplaceableTarget(path: string): Promise<void> {
  try {
    const stat = await lstat(path)
    if (!stat.isFile()) throw unsupportedWorktree(path, stat.isSymbolicLink() ? "symlink" : "non-file")
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error
  }
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
