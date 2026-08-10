import {
  LockContentionError,
  applyFactsBatch,
  restoreFactsBatch,
  type ApplyFactsBatchResult,
  type FactsPeopleRouting,
  type GitMemoryRepo,
  type MemoryIdentity,
  type parseFactsExtractionJsonl,
} from "@oh-my-opencode/memory-core"

import type { OmoConfig } from "@oh-my-opencode/omo-config-core"

import type { ComponentLogger } from "../../extension/types"
import { updateRunLedger } from "./worker/run-artifacts"
import type { FactsRunLedger } from "./facts-runner-types"

const WRITER_ATTEMPTS = 3

export function resolveFactsPeopleRouting(config: OmoConfig, identity: string): FactsPeopleRouting {
  const memory = config.memory
  const override = memory?.agents[identity]?.people
  return {
    enabled: override?.enabled ?? memory?.people.enabled ?? true,
    maxEntries: override?.max_entries ?? memory?.people.max_entries ?? 40,
    maxEntryChars: override?.max_entry_chars ?? memory?.people.max_entry_chars ?? 200,
  }
}

export async function applyFactsWithRetries(options: {
  readonly runDir: string
  readonly ledger: FactsRunLedger
  readonly repo: GitMemoryRepo
  readonly records: ReturnType<typeof parseFactsExtractionJsonl>
  readonly people: FactsPeopleRouting
  readonly identity: MemoryIdentity
  readonly logger?: ComponentLogger
  readonly withWriterLock: <T>(operation: () => Promise<T>, attempt: number) => Promise<T>
  readonly retryDelay?: (attempt: number, delayMs: number) => Promise<void>
  readonly random?: () => number
}): Promise<Extract<ApplyFactsBatchResult, { readonly outcome: "committed" }> | undefined> {
  for (let attempt = 1; attempt <= WRITER_ATTEMPTS; attempt += 1) {
    try {
      const result = await options.withWriterLock(async () => {
        const headBeforeApply = await options.repo.head()
        if (headBeforeApply === null) throw new Error("facts repository has no HEAD")
        await updateRunLedger(`${options.runDir}/ledger.json`, { headBeforeApply })
        await restoreFactsBatch(options.repo, options.records, { people: options.people })
        return applyFactsBatch(options.repo, { batchId: options.ledger.batchId, records: options.records }, {
          agentId: options.identity.id,
          authorName: "Facts Extractor",
        }, {
          people: options.people,
          onAliasTie: (tie) => options.logger?.warn(
            "facts person alias tie resolved by slug order",
            { alias: tie.alias, slugs: tie.slugs.join(","), chosen: tie.chosen },
          ),
        })
      }, attempt)
      if (result.outcome !== "committed") throw new Error("facts batch unexpectedly produced no commit")
      return result
    } catch (error) {
      if (!(error instanceof LockContentionError)) throw error
      if (attempt === WRITER_ATTEMPTS) {
        options.logger?.warn("facts extractor memory-write lock exhausted", { runId: options.ledger.runId })
        return undefined
      }
      const jitter = 25 + Math.floor((options.random ?? Math.random)() * 76)
      await (options.retryDelay ?? delay)(attempt, jitter)
    }
  }
  return undefined
}

function delay(_attempt: number, milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
