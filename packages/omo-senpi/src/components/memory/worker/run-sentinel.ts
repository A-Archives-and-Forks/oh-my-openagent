import { existsSync, watch } from "node:fs"
import { basename, dirname } from "node:path"

export type SentinelWaitResult = "present" | "timeout"

export async function waitForRunSentinel(
  path: string,
  deadlineAt: number,
  now: () => number,
): Promise<SentinelWaitResult> {
  if (existsSync(path)) return "present"
  return await new Promise<SentinelWaitResult>((resolve, reject) => {
    let settled = false
    const name = basename(path)
    const watcher = watch(dirname(path), (_event, changed) => {
      if (changed === name && existsSync(path)) finish("present")
    })
    const timeout = setTimeout(() => finish("timeout"), Math.max(0, deadlineAt - now()))
    const finish = (result: SentinelWaitResult) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      watcher.close()
      resolve(result)
    }
    watcher.once("error", (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      watcher.close()
      reject(error)
    })
    if (existsSync(path)) finish("present")
  })
}
