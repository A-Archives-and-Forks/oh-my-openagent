// Facts queue wiring: publishes a durable queue entry on successful settle and
// re-lists leftover entries at session_start so a crashed extractor run is relaunchable.
// Journal wiring is NOT extended here: it keeps its existing AppendResult contract.

import { join } from "node:path"

import {
  FactsQueue,
  TranscriptJournal,
  type FactsEnqueueResult,
  type FactsQueueEntry,
  type MemoryIdentityPaths,
} from "@oh-my-opencode/memory-core"

import type { ComponentLogger } from "../../extension/types"

const DISABLED: FactsEnqueueResult = { enqueued: false, reason: "no-new-entries" }

export interface FactsExtractorPort {
  launchPending(): Promise<unknown>
  reconcilePending(): Promise<unknown>
}

export interface MemoryFactsWiringOptions {
  readonly identity: string
  readonly identityPaths: MemoryIdentityPaths
  /** `memory.facts.enabled` kill switch, read per call so a config reload is honored. */
  readonly factsEnabled: () => boolean
  readonly debounceSettles?: () => number
  readonly extractor?: FactsExtractorPort
  readonly createJournal?: (journalDir: string) => TranscriptJournal
  readonly now?: () => Date
  readonly logger?: ComponentLogger
}

export interface MemoryFactsWiring {
  /** Enqueue the un-enqueued delta for a settled conversation. Never throws. */
  enqueueSettled(conversationId: string): Promise<FactsEnqueueResult>
  /** Enqueue, count the settle gate, and fire one all-pending launch at the threshold. */
  onSettled(conversationId: string): Promise<FactsEnqueueResult>
  /** Leftover queue entries a crashed run left behind, ready for relaunch. */
  reconcilePending(): Promise<FactsQueueEntry[]>
  /** Fire facts-run reconciliation without blocking session_start on the child. */
  reconcileExtractor(): void
  /** Terminal SUCCESS only: drops the batch and advances the consumed watermark. */
  markConsumed(entries: readonly FactsQueueEntry[]): Promise<void>
}

export function createMemoryFactsWiring(options: MemoryFactsWiringOptions): MemoryFactsWiring {
  const createJournal =
    options.createJournal ?? ((journalDir: string) => new TranscriptJournal({ journalDir }))
  const queue = new FactsQueue({
    identityPaths: options.identityPaths,
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  let settles = 0

  const fire = (operation: "launch" | "reconcile"): void => {
    const promise = operation === "launch"
      ? options.extractor?.launchPending()
      : options.extractor?.reconcilePending()
    void promise?.catch((error) => {
      options.logger?.warn(`facts extractor ${operation} failed`, { error: String(error) })
    })
  }

  const wiring: MemoryFactsWiring = {
    async enqueueSettled(conversationId: string): Promise<FactsEnqueueResult> {
      if (!options.factsEnabled()) return DISABLED
      try {
        const journal = createJournal(join(options.identityPaths.transcripts, conversationId))
        const entries = await journal.readEntries()
        if (entries.length === 0) return DISABLED
        return await queue.enqueue({
          identity: options.identity,
          sessionId: conversationId,
          conversationId,
          entries,
        })
      } catch (error) {
        options.logger?.warn("facts queue enqueue failed", { conversationId, error: String(error) })
        return DISABLED
      }
    },

    async onSettled(conversationId: string): Promise<FactsEnqueueResult> {
      const result = await wiring.enqueueSettled(conversationId)
      if (!options.factsEnabled()) return result
      settles += 1
      if (settles >= Math.max(1, options.debounceSettles?.() ?? 4)) {
        settles = 0
        fire("launch")
      }
      return result
    },

    async reconcilePending(): Promise<FactsQueueEntry[]> {
      if (!options.factsEnabled()) return []
      try {
        return await queue.listPending()
      } catch (error) {
        options.logger?.warn("facts queue reconcile failed", { error: String(error) })
        return []
      }
    },

    reconcileExtractor(): void {
      if (options.factsEnabled()) fire("reconcile")
    },

    async markConsumed(entries: readonly FactsQueueEntry[]): Promise<void> {
      try {
        await queue.markConsumed(entries)
      } catch (error) {
        options.logger?.warn("facts queue consume failed", { error: String(error) })
      }
    },
  }
  return wiring
}
