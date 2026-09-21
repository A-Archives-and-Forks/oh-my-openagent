import { chmod, copyFile, cp, lstat, mkdir, readlink, rm, symlink, utimes } from "node:fs/promises"
import { dirname, join } from "node:path"
import { IsolationUnavailableError, type IsolationBackend, type IsolationContext } from "../backend"
import { exists, git, gitResult } from "../git/command"

export async function seedDirtyState(lower: string, merged: string): Promise<void> {
  const staged = await git(lower, ["diff", "--binary", "--no-color", "--no-ext-diff", "--cached"])
  if (staged.length) await git(merged, ["apply", "--index", "--binary", "-"], staged)
  const unstaged = await git(lower, ["diff", "--binary", "--no-color", "--no-ext-diff"])
  if (unstaged.length) await git(merged, ["apply", "--binary", "-"], unstaged)
  const untracked = await git(lower, ["ls-files", "--others", "--exclude-standard", "-z"])
  for (const name of untracked.toString().split("\0").filter(Boolean)) {
    const src = join(lower, name), dst = join(merged, name)
    const info = await lstat(src)
    await mkdir(dirname(dst), { recursive: true })
    if (info.isSymbolicLink()) await symlink(await readlink(src), dst)
    else if (info.isFile()) {
      await copyFile(src, dst)
      await chmod(dst, info.mode)
      await utimes(dst, info.atime, info.mtime)
    }
    // Sockets, FIFOs and devices are process-local, not copyable state.
  }
}

export class RcopyBackend implements IsolationBackend {
  readonly kind = "rcopy" as const
  readonly clonesTree = false
  async probe(_repoRoot: string) { return { available: true } }

  async start(lower: string, merged: string, ctx: IsolationContext): Promise<void> {
    if (await exists(merged)) throw new Error(`rcopy destination already exists: ${merged}`)
    await mkdir(dirname(merged), { recursive: true })
    if (await exists(join(lower, ".git"))) {
      // Missing git is unavailable, not permission to copy shared git metadata blindly.
      await git(lower, ["worktree", "add", "--detach", merged, "HEAD"])
      await seedDirtyState(lower, merged)
      return
    }
    const ceiling = ctx.maxCopyBytes ?? 8 * 1024 ** 3
    let bytes = 0
    // Count during fs.cp's traversal rather than prewalking the source.
    await cp(lower, merged, {
      recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false, preserveTimestamps: true,
      filter: async (source) => {
        const info = await lstat(source)
        if (info.isFile()) {
          bytes += info.size
          if (bytes > ceiling) throw new Error(`rcopy size ${bytes} bytes exceeds maxCopyBytes ${ceiling}`)
        }
        return info.isFile() || info.isDirectory() || info.isSymbolicLink()
      },
    })
  }

  async stop(merged: string): Promise<void> {
    const entry = join(merged, ".git")
    if (await exists(entry) && (await lstat(entry)).isFile()) {
      // Resolve registration through the worktree itself, including after process restart.
      try { await gitResult(merged, ["worktree", "remove", "--force", merged]) } catch (error) {
        // Teardown remains possible if git disappeared after creation.
        if (!(error instanceof IsolationUnavailableError)) throw error
      }
    }
    await rm(merged, { recursive: true, force: true })
  }
}
