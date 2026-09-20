#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const entrypoint = resolve(repoRoot, "packages", "omo-native", "migration-runtime.ts")
const output = resolve(repoRoot, "packages", "omo-native", "bin", "lib", "migration-runtime.js")
const providerMapSource = resolve(repoRoot, "packages", "omo-native", "bin", "lib", "provider-map.json")

export async function buildMigrationRuntime(): Promise<void> {
  if (!existsSync(entrypoint)) throw new Error(`migration runtime entrypoint is missing: ${entrypoint}`)
  if (!existsSync(providerMapSource)) throw new Error(`provider map source is missing: ${providerMapSource}`)
  mkdirSync(dirname(output), { recursive: true })
  const providerMap = JSON.parse(readFileSync(providerMapSource, "utf8")) as unknown
  if (providerMap === null || typeof providerMap !== "object") {
    throw new Error(`provider map source is malformed: ${providerMapSource}`)
  }
  const temporaryDir = mkdtempSync(join(tmpdir(), "omo-migration-runtime-"))
  try {
    const result = await Bun.build({
      entrypoints: [entrypoint],
      define: { __MIGRATION_PROVIDER_MAP__: JSON.stringify(providerMap) },
      format: "esm",
      target: "node",
      outdir: temporaryDir,
    })
    if (!result.success) {
      const diagnostics = result.logs.map((log) => log.message).join("\n")
      throw new Error(`migration runtime build failed:\n${diagnostics}`)
    }
    renameSync(join(temporaryDir, "migration-runtime.js"), output)
  } finally {
    rmSync(temporaryDir, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  try {
    await buildMigrationRuntime()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
