import { describe, expect, test } from "bun:test"
import { execFile } from "node:child_process"

import { getProcessStartIdentity } from "./process-identity"
import { readDarwinProcessLstart } from "./process-start-time"

const onDarwin = process.platform === "darwin"
const UNREACHABLE_PID = 2_147_483_600

async function lstartViaPs(pid: number): Promise<string | null> {
  return await new Promise((resolve) => {
    execFile("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }, (error, stdout) => {
      if (error !== null) {
        resolve(null)
        return
      }
      const value = stdout.trim()
      resolve(value.length > 0 ? value : null)
    })
  })
}

function collapseWhitespace(value: string | null): string | null {
  return value === null ? null : value.replace(/\s+/g, " ")
}

describe("darwin process start time", () => {
  test.if(onDarwin)(
    "#given the current pid #when the in-process probe reads its start time #then the value equals /bin/ps lstart",
    async () => {
      // #given
      const viaPs = await lstartViaPs(process.pid)

      // #when
      const inProcess = await readDarwinProcessLstart(process.pid)

      // #then
      expect(viaPs).not.toBeNull()
      expect(inProcess).not.toBeNull()
      expect(collapseWhitespace(inProcess)).toBe(collapseWhitespace(viaPs))
    },
  )

  test.if(onDarwin)(
    "#given pids that cannot be inspected #when the probe reads them #then it reports null instead of a guess",
    async () => {
      // #when + #then
      expect(await readDarwinProcessLstart(UNREACHABLE_PID)).toBeNull()
      expect(await readDarwinProcessLstart(0)).toBeNull()
      expect(await readDarwinProcessLstart(-1)).toBeNull()
      expect(await readDarwinProcessLstart(1.5)).toBeNull()
    },
  )

  test.if(onDarwin)(
    "#given the lock identity API #when it resolves the current pid #then it returns the spawn-free probe value verbatim",
    async () => {
      // #given
      const inProcess = await readDarwinProcessLstart(process.pid)

      // #when
      const identity = await getProcessStartIdentity(process.pid)

      // #then
      expect(inProcess).not.toBeNull()
      expect(identity).toBe(`ps-lstart:${collapseWhitespace(inProcess) ?? ""}`)
    },
  )

  test.if(onDarwin)(
    "#given a dead pid #when the lock identity API resolves it #then it reports null so the lock counts as stale",
    async () => {
      // #when
      const identity = await getProcessStartIdentity(UNREACHABLE_PID)

      // #then
      expect(identity).toBeNull()
    },
  )
})
