import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fixture } from "../test-fixture"

export async function git(cwd: string, ...args: string[]) {
  const p = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" })
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  if (code) throw new Error(`git ${args.join(" ")}: ${err}`)
  return out.trim()
}
export async function repo() {
  const f = await fixture()
  await git(f.repoRoot, "init")
  await git(f.repoRoot, "config", "user.name", "Fixture")
  await git(f.repoRoot, "config", "user.email", "fixture@example.invalid")
  await git(f.repoRoot, "config", "core.autocrlf", "false")
  await git(f.repoRoot, "config", "core.symlinks", "false")
  await writeFile(join(f.repoRoot, "tracked"), "base\n")
  await writeFile(join(f.repoRoot, ".gitignore"), "ignored\nnode_modules/\n")
  await git(f.repoRoot, "add", ".")
  await git(f.repoRoot, "commit", "-m", "fixture")
  return f
}
