import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export function credentialDigests(
  credentialFiles: readonly string[],
): Readonly<Record<string, string>> {
  const roots = [join(homedir(), ".omo", "agent"), join(homedir(), ".senpi", "agent")]
  const result: Record<string, string> = {}
  for (const root of roots) {
    for (const name of credentialFiles) {
      const path = join(root, name)
      result[path] = existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : "missing"
    }
  }
  return result
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
