import { existsSync } from "node:fs"
import { join } from "node:path"

/** Bun entry names are relative to --root, not to the relocated executable's cwd. */
export function senpiWorkerCompileArgs(repoRoot: string): string[] {
  const worker = "node_modules/@code-yeongyu/senpi/dist/modes/rpc/session-worker.js"
  // Older pinned engines do not have a shared-session worker.
  if (!existsSync(join(repoRoot, worker))) return []
  return [
    `--root=${repoRoot}`,
    `--define=SENPI_RPC_SESSION_WORKER_ENTRY=${JSON.stringify(`./${worker}`)}`,
    join(repoRoot, worker),
  ]
}
