import { watch } from "node:fs"
import { mkdir, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

export async function waitForFilesystemState<T>(
  directory: string,
  probe: () => T | undefined | Promise<T | undefined>,
  timeoutMs: number,
  description: string,
): Promise<T> {
  const initial = await probe()
  if (initial !== undefined) return initial
  return await new Promise<T>((resolve, reject) => {
    let settled = false
    let checking = false
    const timeout = setTimeout(() => finish(new Error(`waited ${timeoutMs}ms for ${description}`)), timeoutMs)
    const watcher = watch(directory, () => { void check() })
    const finish = (error?: Error, value?: T) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      watcher.close()
      if (error !== undefined) reject(error)
      else resolve(value as T)
    }
    const check = async () => {
      if (settled || checking) return
      checking = true
      try {
        const value = await probe()
        if (value !== undefined) finish(undefined, value)
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      } finally {
        checking = false
      }
    }
    void check()
  })
}

export async function createTestClock(runDir: string, initial: number): Promise<string> {
  const clockDir = join(runDir, "clock-events")
  await mkdir(clockDir, { recursive: true })
  await writeFile(join(clockDir, `000000-${initial}`), "")
  return clockDir
}

export async function advanceTestClock(clockDir: string, value: number): Promise<void> {
  const sequence = (await readdir(clockDir)).length.toString().padStart(6, "0")
  await writeFile(join(clockDir, `${sequence}-${value}`), "")
}
