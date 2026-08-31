import { describe, expect, test } from "bun:test"
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { CONFIG_DIR_NAME } from "../node_modules/@code-yeongyu/senpi/dist/config.js"
import { FileHookStateStorage } from "../node_modules/@code-yeongyu/senpi/dist/core/extensions/builtin/hooks/trust-storage.js"

function withStorage(run: (fixture: {
  root: string
  statePath: string
  storage: FileHookStateStorage
}) => void): void {
  const root = mkdtempSync(join(tmpdir(), "omo-hooks-state-"))
  const cwd = join(root, "project")
  const agentDir = join(root, "agent")
  const statePath = join(cwd, CONFIG_DIR_NAME, "hooks-state.json")
  mkdirSync(dirname(statePath), { recursive: true })
  try {
    run({ root, statePath, storage: new FileHookStateStorage({ cwd, agentDir }) })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function temporarySnapshots(statePath: string): string[] {
  const prefix = `${statePath.split(/[\\/]/).at(-1)}.`
  return readdirSync(dirname(statePath)).filter((name) => name.startsWith(prefix) && name.endsWith(".tmp"))
}

describe("patched Senpi hooks state snapshots", () => {
  test("reads the last complete snapshot while the exact writer lock is held", () => {
    withStorage(({ statePath, storage }) => {
      writeFileSync(statePath, '{"version":1,"hooks":{}}\n', "utf8")
      mkdirSync(`${statePath}.lock`)

      expect(storage.read("project")).toEqual({ version: 1, hooks: {} })
    })
  })

  test("publishes by replacing the destination and leaves no temporary snapshot", () => {
    withStorage(({ statePath, storage }) => {
      writeFileSync(statePath, '{"version":1,"hooks":{}}\n', "utf8")

      const next = storage.update("project", (current) => current)

      expect(storage.read("project")).toEqual(next)
      expect(temporarySnapshots(statePath)).toEqual([])
    })
  })

  test.skipIf(process.platform === "win32")("preserves an existing POSIX snapshot mode", () => {
    withStorage(({ statePath, storage }) => {
      writeFileSync(statePath, '{"version":1,"hooks":{}}\n', "utf8")
      chmodSync(statePath, 0o640)

      storage.update("project", (current) => current)

      expect(statSync(statePath).mode & 0o777).toBe(0o640)
    })
  })

  test.skipIf(process.platform === "win32")("creates a new POSIX snapshot with mode 0600 under a permissive umask", () => {
    withStorage(({ statePath, storage }) => {
      rmSync(statePath, { force: true })
      const previousUmask = process.umask(0)
      try {
        storage.update("project", (current) => current)
      } finally {
        process.umask(previousUmask)
      }

      expect(statSync(statePath).mode & 0o777).toBe(0o600)
    })
  })
})
