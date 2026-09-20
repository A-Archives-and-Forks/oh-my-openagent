import { chmodSync, existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs"

export function assertSetupTargetsUnchanged(targets) {
  for (const { path, bytes } of targets) {
    const current = existsSync(path) ? readFileSync(path, "utf8") : undefined
    if (current !== bytes) throw new Error("Setup destination changed during consent; no files were written. Run setup again")
  }
}

// Backups remain as recovery receipts. This rolls back caught apply failures, not
// abrupt process termination. Validate/capture every target before the first write.
export function withSetupRollback({ files, newDirectories }, apply) {
  const snapshots = files.map((path) => {
    const stat = lstatSync(path, { throwIfNoEntry: false })
    if (stat && !stat.isFile()) throw new Error("Setup target must be a regular file")
    return { path, bytes: stat ? readFileSync(path) : undefined, mode: stat?.mode }
  })
  for (const path of newDirectories) {
    if (lstatSync(path, { throwIfNoEntry: false })) throw new Error("Setup destination changed; run setup again")
  }
  try {
    return apply()
  } catch (error) {
    const failures = [error]
    for (const { path, bytes, mode } of snapshots.reverse()) {
      try {
        if (bytes === undefined) rmSync(path, { force: true })
        else {
          writeFileSync(path, bytes)
          chmodSync(path, mode)
        }
      } catch (rollbackError) {
        failures.push(rollbackError)
      }
    }
    for (const path of newDirectories) {
      try {
        rmSync(path, { recursive: true, force: true })
      } catch (rollbackError) {
        failures.push(rollbackError)
      }
    }
    if (failures.length > 1) throw new AggregateError(failures, "Setup failed and rollback was incomplete; restore the .bak files")
    throw error
  }
}
