import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
    renameSync(temporary, path)
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}

function backupInputs(plan) {
  if (plan.writes.length === 0) return
  mkdirSync(plan.backupDir, { recursive: true, mode: 0o700 })
  const paths = [...new Set([...plan.sourcePaths, ...plan.writes.map((entry) => entry.path)])]
  const files = []
  for (const [index, path] of paths.entries()) {
    if (!existsSync(path)) continue
    const prefix = plan.sourcePaths.includes(path) ? "source" : "target"
    const backup = `${String(index).padStart(3, "0")}-${prefix}-${basename(path)}`
    copyFileSync(path, join(plan.backupDir, backup))
    files.push({ path, backup, role: prefix, mode: statSync(path).mode & 0o777 })
  }
  writeJsonAtomic(join(plan.backupDir, "manifest.json"), {
    files,
    created: plan.writes.filter((entry) => !existsSync(entry.path)).map((entry) => entry.path),
  })
}

export function applyMigrationPlan(plan) {
  backupInputs(plan)
  const written = []
  try {
    for (const entry of plan.writes) {
      const before = existsSync(entry.path) ? readFileSync(entry.path) : undefined
      const mode = before === undefined ? undefined : statSync(entry.path).mode & 0o777
      writeJsonAtomic(entry.path, entry.value)
      written.push({ before, mode, path: entry.path })
    }
  } catch (error) {
    const failures = [error]
    for (const entry of written.reverse()) {
      try {
        if (entry.before === undefined) unlinkSync(entry.path)
        else {
          writeFileSync(entry.path, entry.before)
          chmodSync(entry.path, entry.mode)
        }
      } catch (rollbackError) {
        failures.push(rollbackError)
      }
    }
    if (failures.length > 1) throw new AggregateError(failures, "Migration rollback was incomplete; restore files using the backup manifest")
    throw error
  }
}
