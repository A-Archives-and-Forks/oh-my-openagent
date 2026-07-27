import { isPlainObject } from "../internal/plain-object"
import { parseJsoncSafe } from "../internal/jsonc-parse"
import { writePreparedTarget, writeOmoMigrationTarget, prepareTargetWrite, targetDocument } from "./commit"
import { type MigrationBackupMove, migrationJournalPath, removeMigrationJournal, writeMigrationJournal } from "./journal"
import { acquireMigrationLock, migrationLockPath } from "./lock"
import { shouldRunMigration } from "./predicate"
import { resumeMigrationJournal } from "./recovery"
import {
  DEFAULT_MIGRATION_CLOCK,
  DEFAULT_MIGRATION_FILE_SYSTEM,
  DEFAULT_MIGRATION_PROCESS,
  MigrationTransactionError,
  type LoadedMigrationSource,
  type MigrationEnvironment,
  type MigrationFileSystem,
  type MigrationProcess,
  type MigrationRunResult,
  type MigrationSourceDescriptor,
  type RunMigrationOptions,
} from "./types"

function parseSource(path: string, content: string): unknown {
  const parsed = parseJsoncSafe<unknown>(content)
  if (parsed.errors.length > 0) {
    const detail = parsed.errors.map((error) => `${error.message} at ${error.offset}`).join(", ")
    throw new MigrationTransactionError(`Migration source at ${path} is invalid JSONC: ${detail}`)
  }
  return parsed.data
}

function loadSources(
  sources: readonly MigrationSourceDescriptor[],
  fileSystem: MigrationFileSystem,
): readonly LoadedMigrationSource[] {
  return sources
    .filter((source) => fileSystem.existsSync(source.path))
    .map((source) => ({ ...source, value: parseSource(source.path, fileSystem.readFileSync(source.path, "utf-8")) }))
}

function backupBasePath(source: MigrationSourceDescriptor, migrationId: string): string {
  return source.backupPath ?? `${source.path}.bak.${encodeURIComponent(migrationId)}`
}

function backupMoves(
  sources: readonly MigrationSourceDescriptor[],
  migrationId: string,
  fileSystem: MigrationFileSystem,
  protectedPaths: ReadonlySet<string>,
): readonly MigrationBackupMove[] {
  const paths = new Set(sources.map((source) => source.path))
  const destinations = new Set<string>()
  const moves: MigrationBackupMove[] = []

  for (const source of sources) {
    if (!fileSystem.existsSync(source.path)) continue
    const basePath = backupBasePath(source, migrationId)
    let destination = basePath
    let attempt = 1
    while (fileSystem.existsSync(destination) || destinations.has(destination)) {
      if (source.backupPath !== undefined) {
        throw new MigrationTransactionError(`Migration backup path already exists: ${destination}`)
      }
      destination = `${basePath}.${attempt}`
      attempt += 1
    }
    if (paths.has(destination) || protectedPaths.has(destination)) {
      throw new MigrationTransactionError(`Migration backup path is protected: ${destination}`)
    }
    destinations.add(destination)
    moves.push({ from: source.path, to: destination })
  }

  return moves
}

function assertSafeSourcePaths(sources: readonly MigrationSourceDescriptor[], protectedPaths: ReadonlySet<string>): void {
  const seen = new Set<string>()
  for (const source of sources) {
    if (seen.has(source.path)) throw new MigrationTransactionError(`Duplicate migration source: ${source.path}`)
    if (protectedPaths.has(source.path)) throw new MigrationTransactionError(`Migration source is protected: ${source.path}`)
    seen.add(source.path)
  }
}

export function runMigration(options: RunMigrationOptions): MigrationRunResult {
  const clock = options.clock ?? DEFAULT_MIGRATION_CLOCK
  const home = globalThis.process.env["HOME"]
  const userProfile = globalThis.process.env["USERPROFILE"]
  const env: MigrationEnvironment = options.env ?? {
    ...(home === undefined ? {} : { HOME: home }),
    ...(userProfile === undefined ? {} : { USERPROFILE: userProfile }),
  }
  const fileSystem = options.fileSystem ?? DEFAULT_MIGRATION_FILE_SYSTEM
  const migrationProcess: MigrationProcess = {
    isAlive: options.isProcessAlive ?? DEFAULT_MIGRATION_PROCESS.isAlive,
    pid: options.pid ?? DEFAULT_MIGRATION_PROCESS.pid,
  }
  const writeTarget = options.writeTarget ?? writeOmoMigrationTarget
  const lock = acquireMigrationLock({
    clock,
    env,
    fileSystem,
    ...(options.leaseDurationMs === undefined ? {} : { leaseDurationMs: options.leaseDurationMs }),
    process: migrationProcess,
  })
  if (lock === null) return { diagnostics: [], journalResumed: false, status: "locked" }

  try {
    const journalResumed = resumeMigrationJournal({
      clock,
      env,
      fileSystem,
      process: migrationProcess,
      renewLock: lock.renew,
      writeTarget,
    })
    lock.renew()
    const protectedPaths = new Set([
      options.targetPath,
      migrationJournalPath(env),
      migrationLockPath(env),
    ])
    assertSafeSourcePaths(options.sources, protectedPaths)
    const existingSources = options.sources.filter((source) => fileSystem.existsSync(source.path))
    const target = targetDocument(options.targetPath, fileSystem)
    if (!shouldRunMigration({
      legacySourcesExist: existingSources.length > 0,
      migrationId: options.id,
      target,
    })) {
      return { diagnostics: [], journalResumed, status: "skipped" }
    }

    const transformed = options.transform(loadSources(existingSources, fileSystem))
    if (!isPlainObject(transformed)) throw new MigrationTransactionError("Migration transform must return a plain object")
    const prepared = prepareTargetWrite({
      additions: transformed,
      migrationId: options.id,
      target,
      targetPath: options.targetPath,
    })
    const journal = {
      backupMoves: backupMoves(existingSources, options.id, fileSystem, protectedPaths),
      completedMoves: [],
      migrationId: options.id,
      targetPath: options.targetPath,
      targetWrite: { additions: transformed },
      targetWritten: false,
      version: 1 as const,
    }
    writeMigrationJournal(journal, fileSystem, env, migrationProcess, clock)
    options.onBoundary?.("journal-written")
    lock.renew()
    writePreparedTarget({ env, fileSystem, prepared, targetPath: options.targetPath, writeTarget })
    options.onBoundary?.("target-written")
    const targetRecorded = { ...journal, targetWritten: true }
    writeMigrationJournal(targetRecorded, fileSystem, env, migrationProcess, clock)
    options.onBoundary?.("target-recorded")

    for (const move of targetRecorded.backupMoves) {
      lock.renew()
      if (fileSystem.existsSync(move.to)) {
        throw new MigrationTransactionError(`Migration backup path already exists: ${move.to}`)
      }
      fileSystem.renameSync(move.from, move.to)
      options.onBoundary?.("source-moved")
      const completedMoves = [...targetRecorded.completedMoves, move.from]
      Object.assign(targetRecorded, { completedMoves })
      writeMigrationJournal(targetRecorded, fileSystem, env, migrationProcess, clock)
      options.onBoundary?.("source-recorded")
    }
    removeMigrationJournal(fileSystem, env)
    return { diagnostics: prepared.diagnostics, journalResumed, status: "migrated" }
  } finally {
    lock.release()
  }
}
