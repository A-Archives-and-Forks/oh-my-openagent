import { randomBytes } from "node:crypto"
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

const WINDOWS_RENAME_RETRIES = 8
const WINDOWS_RENAME_RETRY_MS = 5
const WINDOWS_TRANSIENT_CODES: ReadonlySet<string> = new Set(["EPERM", "EBUSY", "EACCES"])
const sleeper = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))

// Shared by task records and plain workpool data. Callers own the short record lock.
export function atomicReplace(path: string, payload: string, platform: NodeJS.Platform = process.platform): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmpPath = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
  try {
    writeFileSync(tmpPath, payload, "utf8")
    renameWithWindowsRetry(tmpPath, path, platform)
  } finally {
    rmSync(tmpPath, { force: true })
  }
}

function renameWithWindowsRetry(from: string, to: string, platform: NodeJS.Platform): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(from, to)
      return
    } catch (error) {
      if (platform !== "win32" || attempt >= WINDOWS_RENAME_RETRIES || !isTransientWindowsError(error)) throw error
      Atomics.wait(sleeper, 0, 0, WINDOWS_RENAME_RETRY_MS)
    }
  }
}

function isTransientWindowsError(error: unknown): boolean {
  return error instanceof Error && "code" in error && typeof error.code === "string" && WINDOWS_TRANSIENT_CODES.has(error.code)
}
