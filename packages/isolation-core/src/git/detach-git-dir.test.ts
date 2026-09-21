import { expect, test } from "bun:test"
import { cp, lstat, mkdir, readFile, writeFile } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"
import { git, repo } from "../backends/git-fixture"
import { detachGitDir, scanNestedGitDirs } from "./detach-git-dir"
import { IsolationUnavailableError } from "../backend"
import { ensureIsolation, cleanupIsolation } from "../ensure"
import { RcopyBackend } from "../backends/rcopy"

test("linked-worktree detach uses private metadata and alternates, allowlists config and removes own registration", async () => {
  const { repoRoot: source, root } = await repo()
  await git(source, "config", "remote.origin.url", "https://example.invalid/private")
  await git(source, "config", "core.hooksPath", "/untrusted/hooks")
  const lower = join(root, "linked")
  await git(source, "worktree", "add", "--detach", lower, "HEAD")
  const merged = join(root, "merged")
  await git(lower, "worktree", "add", "--detach", merged, "HEAD")
  const admin = (await readFile(join(merged, ".git"), "utf8")).trim().slice(8)
  const common = await git(lower, "rev-parse", "--path-format=absolute", "--git-common-dir")
  expect(await detachGitDir(merged, common)).toBe("detached")
  expect(resolve(merged, await git(merged, "rev-parse", "--git-common-dir"))).toBe(join(merged, ".git"))
  expect(await git(merged, "log", "-1", "--format=%s")).toBe("fixture")
  expect(await git(source, "worktree", "list", "--porcelain")).not.toContain(merged)
  expect(await git(source, "worktree", "list", "--porcelain")).toContain(lower)
  await expect(lstat(admin)).rejects.toMatchObject({ code: "ENOENT" })
  const config = await readFile(join(merged, ".git/config"), "utf8")
  expect(config).not.toContain("origin")
  expect(config).not.toContain("hooksPath")
  expect(await git(merged, "config", "user.name")).toBe("Fixture")
})

test("directory metadata removes nested lock files and worktree/bare configuration; absent metadata is no-git", async () => {
  const { repoRoot, root } = await repo()
  await writeFile(join(repoRoot, ".git/index.lock"), "stale")
  await mkdir(join(repoRoot, ".git/refs/heads/nested"), { recursive: true })
  await writeFile(join(repoRoot, ".git/refs/heads/nested/ref.lock"), "stale")
  await git(repoRoot, "config", "core.worktree", root)
  await git(repoRoot, "config", "core.bare", "false")
  expect(await detachGitDir(repoRoot, join(repoRoot, ".git"))).toBe("independent")
  for (const path of ["index.lock", "refs/heads/nested/ref.lock"]) await expect(lstat(join(repoRoot, ".git", path))).rejects.toMatchObject({ code: "ENOENT" })
  expect(await readFile(join(repoRoot, ".git/config"), "utf8")).not.toMatch(/worktree|bare/)
  const empty = join(root, "empty"); await mkdir(empty)
  expect(await detachGitDir(empty, join(repoRoot, ".git"))).toBe("no-git")
})

test("copied linked metadata never deletes the source worktree admin", async () => {
  const { repoRoot, root } = await repo()
  const linked = join(root, "linked"), merged = join(root, "merged")
  await git(repoRoot, "worktree", "add", "--detach", linked, "HEAD")
  await cp(linked, merged, { recursive: true })
  await detachGitDir(merged, join(repoRoot, ".git"))
  expect(await git(linked, "status", "--porcelain")).toBe("")
  expect(await git(repoRoot, "worktree", "list", "--porcelain")).toContain(linked)
})

test("nested relative submodule metadata remains functional; external metadata rewrites or fails closed", async () => {
  const { repoRoot: source, root } = await repo()
  const { repoRoot: sub } = await repo()
  await git(source, "-c", "protocol.file.allow=always", "submodule", "add", sub, "libs/sub")
  await git(source, "commit", "-am", "submodule")
  const merged = join(root, "merged")
  await cp(source, merged, { recursive: true })
  await detachGitDir(merged, join(source, ".git"))
  expect((await scanNestedGitDirs(merged)).nested_git_rewritten).toEqual([])
  expect(await git(join(merged, "libs/sub"), "status", "--porcelain")).toBe("")
  const absolute = join(source, ".git/modules/libs/sub")
  expect(isAbsolute(absolute)).toBe(true)
  await writeFile(join(merged, "libs/sub/.git"), `gitdir: ${absolute}\n`)
  expect((await scanNestedGitDirs(merged)).nested_git_rewritten).toEqual(["libs/sub"])
  expect(await git(join(merged, "libs/sub"), "status", "--porcelain")).toBe("")
  const foreign = join(root, "foreign")
  await mkdir(join(foreign, "libs/sub"), { recursive: true })
  await writeFile(join(foreign, "libs/sub/.git"), `gitdir: ${absolute}\n`)
  await expect(scanNestedGitDirs(foreign)).rejects.toBeInstanceOf(IsolationUnavailableError)
  await expect(scanNestedGitDirs(foreign)).rejects.toThrow("libs/sub")
})

test("ensure retries one inconsistent clone, detaches before publication, then refuses repeated corruption", async () => {
  const { repoRoot, homeDir } = await repo()
  let starts = 0
  const base = new RcopyBackend()
  const backend = {
    kind: base.kind, clonesTree: false, probe: base.probe.bind(base), stop: base.stop.bind(base),
    start: async (...args: Parameters<typeof base.start>) => {
      await base.start(...args)
      starts++
      const admin = (await readFile(join(args[1], ".git"), "utf8")).trim().slice(8)
      if (starts === 1) await writeFile(join(admin, "index"), "broken")
    },
  }
  const h = await ensureIsolation({ repoRoot, homeDir, id: "retry", backends: [backend] })
  expect(starts).toBe(2)
  expect((await lstat(join(h.mergedDir, ".git"))).isDirectory()).toBe(true)
  expect(await git(h.mergedDir, "status", "--porcelain")).toBe("")
  expect(await git(repoRoot, "worktree", "list", "--porcelain")).not.toContain(".creating-")
  await cleanupIsolation(h)
  starts = 0
  backend.start = async (...args) => {
    await base.start(...args); starts++
    const admin = (await readFile(join(args[1], ".git"), "utf8")).trim().slice(8)
    await writeFile(join(admin, "index"), "broken")
  }
  await expect(ensureIsolation({ repoRoot, homeDir, id: "bad", backends: [backend] })).rejects.toBeInstanceOf(IsolationUnavailableError)
  expect(starts).toBe(2)
})
