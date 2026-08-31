import { afterAll, afterEach, describe, expect, mock, test } from "bun:test"
import * as actualFs from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

const failures: { publication?: Error; cleanup?: Error } = {}
const realRenameSync = actualFs.renameSync
const realRmSync = actualFs.rmSync

mock.module("node:fs", () => ({
  ...actualFs,
  renameSync: (...args: Parameters<typeof actualFs.renameSync>) => {
    if (failures.publication) throw failures.publication
    return realRenameSync(...args)
  },
  rmSync: (...args: Parameters<typeof actualFs.rmSync>) => {
    if (failures.cleanup) throw failures.cleanup
    return realRmSync(...args)
  },
}))

import { FileHookStateStorage } from "../node_modules/@code-yeongyu/senpi/dist/core/extensions/builtin/hooks/trust-storage.js"

const roots: string[] = []

function fixture(): { statePath: string; storage: FileHookStateStorage } {
  const root = actualFs.mkdtempSync(join(tmpdir(), "omo-hooks-errors-"))
  roots.push(root)
  const cwd = join(root, "project")
  const agentDir = join(root, "agent")
  const statePath = join(cwd, ".senpi", "hooks-state.json")
  actualFs.mkdirSync(dirname(statePath), { recursive: true })
  return { statePath, storage: new FileHookStateStorage({ cwd, agentDir }) }
}

afterEach(() => {
  failures.publication = undefined
  failures.cleanup = undefined
  for (const root of roots.splice(0)) realRmSync(root, { recursive: true, force: true })
})

afterAll(() => mock.restore())

describe("patched Senpi hooks state publication failures", () => {
  test("cleans failed publication and preserves ordered publication plus cleanup errors", () => {
    const first = fixture()
    const firstPublicationError = new Error("injected publication failure with successful cleanup")
    failures.publication = firstPublicationError

    expect(() => first.storage.update("project", (current) => current)).toThrow(firstPublicationError)
    expect(actualFs.readdirSync(dirname(first.statePath)).filter((name) => name.endsWith(".tmp"))).toEqual([])

    const second = fixture()
    const publicationError = new Error("injected publication failure")
    const cleanupError = new Error("injected cleanup failure")
    failures.publication = publicationError
    failures.cleanup = cleanupError

    let thrown: unknown
    try {
      second.storage.update("project", (current) => current)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(AggregateError)
    expect(thrown).toMatchObject({
      message: "Failed to publish and clean up hook trust state snapshot",
      errors: [publicationError, cleanupError],
    })
  })
})
