import { afterEach, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  ensureVendoredLspDaemonBuilt,
  type RunVendoredLspCommand,
} from "./ensure-vendored-lsp-daemon"

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: (value: T) => void = () => {}
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })
  return { promise, resolve: resolvePromise }
}

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe("ensureVendoredLspDaemonBuilt", () => {
  it("#given two callers over one missing dist #when the first build is held and the second enters #then one build runs and both observe the output", async () => {
    // given
    const root = await mkdtemp(join(tmpdir(), "omo-lsp-build-lock-"))
    temporaryRoots.push(root)
    const packageDir = join(root, "lsp-daemon")
    const outputPath = join(packageDir, "dist", "cli.js")
    await mkdir(packageDir, { recursive: true })

    const firstInstallStarted = deferred<void>()
    const releaseFirstInstall = deferred<void>()
    let installCount = 0

    const runCommand: RunVendoredLspCommand = async (_command, args) => {
      if (args[0] === "ci") {
        installCount += 1
        if (installCount === 1) {
          firstInstallStarted.resolve()
          await releaseFirstInstall.promise
        }
        return 0
      }

      await mkdir(join(packageDir, "dist"), { recursive: true })
      await writeFile(outputPath, "built")
      return 0
    }

    const build = () =>
      ensureVendoredLspDaemonBuilt({
        packageDir,
        outputPath,
        runCommand,
        log: () => {},
      })

    // when
    const firstBuild = build()
    await firstInstallStarted.promise
    const secondBuild = build()
    releaseFirstInstall.resolve()
    await Promise.all([firstBuild, secondBuild])

    // then
    expect(installCount).toBe(1)
  })
})
