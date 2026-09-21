import { execFile } from "node:child_process"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fixture } from "../test-fixture"

export async function git(cwd: string, ...args: string[]) {
  const [code, out, err] = await new Promise<[number, string, string]>((resolve, reject) => {
    execFile("git", ["-C", cwd, ...args], { maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && error.code === undefined) return reject(error)
      resolve([(error?.code as number | undefined) ?? 0, stdout.toString(), stderr.toString()])
    })
  })
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
