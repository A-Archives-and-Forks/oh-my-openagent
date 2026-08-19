import { RunnerError } from "../in-process/runner-error"
import type { RpcRunnerSpec } from "../types"
import { type ModelCatalogProbeResult, parseModelCatalog, probeModelCatalog } from "./model-catalog-probe"
import { buildRpcModelCatalogSpawn, type RpcSpawnDescriptor } from "./spawn"

export { parseModelCatalog, probeModelCatalog, PROBE_TIMEOUT_MS } from "./model-catalog-probe"
export type {
  ModelCatalogProbeOptions,
  ModelCatalogProbeResult,
  ModelCatalogSpawnOptions,
} from "./model-catalog-probe"

/**
 * A successful catalog is cached only briefly: `senpi auth login` or an edit to the child-visible
 * settings changes which models resolve, and nothing in this process observes that. A short TTL
 * bounds how long a stale success can reject an otherwise valid model.
 */
export const MODEL_CATALOG_CACHE_TTL_MS = 120_000

export type RpcModelAdmission = (spec: RpcRunnerSpec) => Promise<void>

export type RpcModelAdmissionOptions = {
  readonly buildSpawn?: (spec: RpcRunnerSpec) => RpcSpawnDescriptor
  readonly probe?: (descriptor: RpcSpawnDescriptor) => Promise<ModelCatalogProbeResult>
  readonly now?: () => number
}

type ProbedCatalog = {
  readonly models: ReadonlySet<string>
  readonly stderrTail: string
}

type CachedCatalog = {
  readonly catalog: Promise<ProbedCatalog>
  readonly cachedAt: number
}

function profileKey(descriptor: RpcSpawnDescriptor): string {
  return JSON.stringify([
    descriptor.command,
    descriptor.args,
    descriptor.cwd,
    descriptor.env.OMO_CODING_AGENT_DIR,
    descriptor.env.SENPI_CODING_AGENT_DIR,
    descriptor.env.PI_CODING_AGENT_DIR,
    descriptor.env.HOME,
    descriptor.env.USERPROFILE,
    descriptor.env.XDG_CONFIG_HOME,
  ])
}

function admissionFailure(model: string, message: string, cause?: unknown): RunnerError {
  return new RunnerError({
    kind: "model_unavailable",
    message: `process model admission failed for ${model}: ${message}`,
    ...(cause === undefined ? {} : { cause }),
  })
}

export function createRpcModelAdmission(options: RpcModelAdmissionOptions = {}): RpcModelAdmission {
  const buildSpawn = options.buildSpawn ?? buildRpcModelCatalogSpawn
  const probe = options.probe ?? probeModelCatalog
  const now = options.now ?? Date.now
  const catalogs = new Map<string, CachedCatalog>()

  return async (spec) => {
    const model = spec.model?.trim()
    if (model === undefined || model.length === 0) return
    const descriptor = buildSpawn(spec)
    const key = profileKey(descriptor)
    const cached = catalogs.get(key)
    let catalog = cached !== undefined && now() - cached.cachedAt < MODEL_CATALOG_CACHE_TTL_MS ? cached.catalog : undefined
    if (catalog === undefined) {
      catalog = probe(descriptor).then((result) => {
        if (result.timedOut) throw admissionFailure(model, "catalog probe timed out")
        if (result.code !== 0) {
          const detail = result.stderr.trim().slice(-2_000)
          throw admissionFailure(model, `catalog probe exited ${result.code}${detail.length === 0 ? "" : `: ${detail}`}`)
        }
        return { models: parseModelCatalog(result.stdout), stderrTail: result.stderr.trim().slice(-1_000) }
      })
      catalogs.set(key, { catalog, cachedAt: now() })
    }
    try {
      const available = await catalog
      if (!available.models.has(model)) {
        throw admissionFailure(
          model,
          `model is not visible in the child profile (probed catalog has ${available.models.size} models${
            available.stderrTail.length === 0 ? "" : `; child stderr: ${available.stderrTail}`
          }); forward its provider extension or child-visible settings`,
        )
      }
    } catch (error) {
      catalogs.delete(key)
      throw error
    }
  }
}
