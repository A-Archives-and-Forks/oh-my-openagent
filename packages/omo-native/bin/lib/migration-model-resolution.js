import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// The engine's public catalog factory accepts a path, not an in-memory document.
// Inspect the complete proposed catalog privately without touching any target.
export async function canResolveModel(modelsConfig, provider, model) {
  const { ModelRuntime } = await import("@code-yeongyu/senpi")
  const scratch = mkdtempSync(join(tmpdir(), "omo-migration-catalog-"))
  try {
    const modelsPath = join(scratch, "models.json")
    writeFileSync(modelsPath, JSON.stringify(modelsConfig), { mode: 0o600 })
    const runtime = ModelRuntime.createSync({
      modelsPath,
      allowModelNetwork: false,
      refreshOnCreate: false,
      credentials: {
        async read() { return undefined },
        async list() { return [] },
        async modify() { throw new Error("Migration catalog inspection cannot modify credentials") },
        async delete() { throw new Error("Migration catalog inspection cannot delete credentials") },
      },
    })
    return runtime.getModel(provider, model) !== undefined
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}
