import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve, sep } from "node:path"
import { IsolationUnavailableError } from "../backend"
import { exists, git, gitResult } from "./command"

async function canonical(path: string): Promise<string> {
  const value = await realpath(path)
  return process.platform === "win32" ? value.toLowerCase() : value
}
async function gitdir(entry: string): Promise<string> {
  const text = (await readFile(entry, "utf8")).trim()
  if (!text.startsWith("gitdir: ")) throw new Error(`Invalid gitdir file: ${entry}`)
  return resolve(dirname(entry), text.slice(8))
}
async function removeLocks(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.name.endsWith(".lock")) await rm(path, { recursive: true, force: true })
    else if (entry.isDirectory()) await removeLocks(path)
  }
}
async function unset(config: string, key: string): Promise<void> {
  const result = await gitResult(dirname(config), ["config", "--file", config, "--unset-all", key])
  if (result.code !== 0 && result.code !== 5) throw new Error(`git config unset ${key}: ${result.stderr}`)
}
async function copyOptional(src: string, dst: string): Promise<void> {
  if (!(await exists(src))) return
  await mkdir(dirname(dst), { recursive: true })
  await cp(src, dst, { recursive: true, verbatimSymlinks: true, force: false, errorOnExist: true })
}

export async function detachGitDir(worktreeRoot: string, sourceCommonDir: string): Promise<"no-git" | "independent" | "detached"> {
  const entry = join(worktreeRoot, ".git")
  if (!(await exists(entry))) return "no-git"
  const meta = await lstat(entry)
  if (meta.isDirectory()) {
    await removeLocks(entry)
    if (await exists(join(entry, "config"))) {
      await unset(join(entry, "config"), "core.worktree")
      await unset(join(entry, "config"), "core.bare")
    }
    return "independent"
  }
  if (!meta.isFile()) throw new IsolationUnavailableError(".git must not share metadata through a symlink")
  const admin = await gitdir(entry)
  const common = await realpath(sourceCommonDir)
  let ownAdmin = false
  if (await exists(join(admin, "gitdir"))) {
    const backPointer = (await readFile(join(admin, "gitdir"), "utf8")).trim()
    const target = resolve(admin, backPointer)
    if (await exists(target)) ownAdmin = await canonical(target) === await canonical(entry)
  }
  const privateDir = join(worktreeRoot, ".git-private")
  await mkdir(privateDir)
  try {
    await mkdir(join(privateDir, "objects/info"), { recursive: true })
    await mkdir(join(privateDir, "refs"))
    await writeFile(join(privateDir, "HEAD"), await readFile(join(admin, "HEAD")))
    await writeFile(join(privateDir, "config"), "[core]\n\trepositoryformatversion = 0\n")
    if (await exists(join(common, "config"))) {
      const config = await git(common, ["config", "--file", join(common, "config"), "--null", "--list", "--no-includes"])
      for (const record of config.toString().split("\0").filter(Boolean)) {
        const split = record.indexOf("\n")
        const key = split < 0 ? record : record.slice(0, split)
        const value = split < 0 ? "true" : record.slice(split + 1)
        if (/^(user\..+|core\.(filemode|splitindex|sparsecheckout.*|symlinks|autocrlf|ignorecase))$/i.test(key)) {
          await git(privateDir, ["config", "--file", join(privateDir, "config"), "--add", key, value])
        }
      }
    }
    for (const name of await readdir(join(common, "refs"))) await copyOptional(join(common, "refs", name), join(privateDir, "refs", name))
    await copyOptional(join(common, "packed-refs"), join(privateDir, "packed-refs"))
    for (const name of ["index", "info/sparse-checkout", "shallow", ...(await readdir(admin)).filter(name => name.startsWith("sharedindex."))]) {
      await copyOptional(join(admin, name), join(privateDir, name))
    }
    if (!(await exists(join(privateDir, "shallow")))) await copyOptional(join(common, "shallow"), join(privateDir, "shallow"))
    await writeFile(join(privateDir, "objects/info/alternates"), `${join(common, "objects")}\n`)
    await removeLocks(privateDir)
    await rm(entry)
    await rename(privateDir, entry)
  } catch (error) {
    await rm(privateDir, { recursive: true, force: true })
    throw error
  }
  if (ownAdmin) {
    await rm(admin, { recursive: true })
    await git(common, ["--git-dir", common, "worktree", "prune"])
  }
  return "detached"
}

export interface NestedGitResult {
  nested_git_rewritten: string[]
  nested_git_skipped: string[]
}
export async function scanNestedGitDirs(merged: string): Promise<NestedGitResult> {
  const result: NestedGitResult = { nested_git_rewritten: [], nested_git_skipped: [] }
  const root = await canonical(merged)
  const inside = (path: string) => path === root || path.startsWith(`${root}${sep}`)
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 0) {
      const entry = join(dir, ".git")
      if (await exists(entry)) {
        const meta = await lstat(entry)
        if (meta.isSymbolicLink()) throw new IsolationUnavailableError(`submodule ${relative(merged, dir)} shares the source gitdir`)
        if (meta.isFile()) {
          const target = await gitdir(entry)
          const resolved = await canonical(target)
          if (!inside(resolved)) {
            const path = relative(merged, dir).split(sep).join("/")
            const replacement = join(merged, ".git/modules", path)
            if (!(await exists(replacement)) || !inside(await canonical(replacement))) {
              throw new IsolationUnavailableError(`submodule ${path} shares the source gitdir`)
            }
            await writeFile(entry, `gitdir: ${relative(dir, replacement).split(sep).join("/")}\n`)
            result.nested_git_rewritten.push(path)
          }
        }
      }
    }
    if (depth === 6) return
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== ".git" && entry.name !== "node_modules") await walk(join(dir, entry.name), depth + 1)
    }
  }
  await walk(merged, 0)
  return result
}
