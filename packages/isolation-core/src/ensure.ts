import { randomBytes } from "node:crypto"
import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { IsolationUnavailableError, resolveCandidates, type BackendKind, type IsolationBackend } from "./backend"
import { chooseBaseDir } from "./base-dir"
import { writeOwnerMarker, type IsolationOwner } from "./owner"

export interface IsolationHandle {
  readonly mergedDir: string
  readonly baseDir: string
  readonly backend: BackendKind
  readonly fellBack: boolean
  readonly fallbackReason: string | null
  readonly stop: (mergedDir: string) => Promise<void>
}

export interface EnsureIsolationOptions {
  readonly repoRoot: string
  readonly id: string
  readonly preferred?: BackendKind | "auto"
  readonly backends: readonly IsolationBackend[]
  readonly platform?: NodeJS.Platform
  readonly homeDir?: string
  readonly owner?: IsolationOwner
}

export class IsolationExistsError extends Error {
  readonly name = "IsolationExistsError"
  readonly code = "isolation_exists"
}

export async function ensureIsolation(options: EnsureIsolationOptions): Promise<IsolationHandle> {
  const { repoRoot, id, backends } = options
  const { baseDir, crossDevice } = await chooseBaseDir(repoRoot, options.homeDir ?? homedir(), id)
  const { candidates } = resolveCandidates(options.platform ?? process.platform, options.preferred)
  const creating = `${baseDir}.creating-${process.pid}`
  const merged = join(creating, "m")
  try {
    await lstat(baseDir)
    throw new IsolationExistsError(`Isolation already exists: ${baseDir}`)
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
  }
  let fallbackReason: string | null = null
  for (const [index, kind] of candidates.entries()) {
    const backend = backends.find((entry) => entry.kind === kind)
    if (!backend) {
      fallbackReason ??= `No implementation for ${kind}`
      continue
    }
    try {
      const probe = await backend.probe(repoRoot)
      if (!probe.available) throw new IsolationUnavailableError(probe.reason ?? `${kind} is unavailable`)
      if (crossDevice && backend.clonesTree) throw new IsolationUnavailableError(`${kind} requires the same device`)
    } catch (error) {
      if (!(error instanceof IsolationUnavailableError)) throw error
      fallbackReason ??= error.message
      continue
    }
    await mkdir(dirname(baseDir), { recursive: true })
    // Exclusive creation prevents another ensure in this process from deleting an active clone.
    await mkdir(creating)
    let startAttempted = false
    try {
      await writeOwnerMarker(creating, id, options.owner)
      await writeFile(join(creating, ".omo-isolation-backend.json"), JSON.stringify({ backend: kind }))
      startAttempted = true
      await backend.start(repoRoot, merged, { id, baseDir: creating, crossDevice })
      await rename(creating, baseDir)
      return {
        baseDir, mergedDir: join(baseDir, "m"), backend: kind,
        fellBack: index > 0, fallbackReason,
        stop: (path) => backend.stop(path),
      }
    } catch (error) {
      if (startAttempted) {
        try {
          await backend.stop(merged)
        } catch (stopError) {
          throw new AggregateError([error, stopError], `Isolation teardown failed: ${creating}`)
        }
      }
      await rm(creating, { recursive: true, force: true })
      if (!(error instanceof IsolationUnavailableError)) throw error
      fallbackReason ??= error.message
    }
  }
  throw new IsolationUnavailableError(fallbackReason ?? "No isolation backend is available")
}

export async function cleanupIsolation(handle: IsolationHandle): Promise<void> {
  await handle.stop(handle.mergedDir)
  await rm(handle.baseDir, { recursive: true, force: true })
}

export async function retainIsolation(handle: IsolationHandle, reason: string): Promise<string> {
  const retained = `${handle.baseDir}.retained-${Date.now()}-${randomBytes(6).toString("hex")}`
  await writeFile(join(handle.baseDir, ".omo-isolation-retained.json"), JSON.stringify({ reason }))
  await rename(handle.baseDir, retained)
  return retained
}
