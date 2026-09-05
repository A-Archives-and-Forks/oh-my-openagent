import type { EntryRenderer } from "@code-yeongyu/senpi"
import { touchesSoulPath, type MemoryToolCommit } from "@oh-my-opencode/memory-core"

import type { MemoryExtensionAPI } from "./capabilities"
import type { MemoryIdentityContext } from "./context"
import { renderMemoryWriteNotice } from "./memory-write-render"
import { SOUL_UPDATED_ENTRY_TYPE, renderSoulUpdatedEntry, type SoulUpdatedRecord } from "./soul-notice"
import type { MemoryWriteNotice } from "./tools"

export const MEMORY_WRITE_UPDATED_ENTRY_TYPE = "omo-memory:write-updated"

export const renderMemoryWriteUpdatedEntry: EntryRenderer<MemoryWriteNotice> = (entry, options, theme) => {
  const record = entry.data
  return record === undefined ? undefined : renderMemoryWriteNotice(record, options, theme, Date.now())
}
export interface MemoryNoticeWiringOptions {
  readonly resolveContext: (sessionId: string) => MemoryIdentityContext | undefined
  readonly resolveEditNotice: (identity: string) => boolean
}

export interface MemoryNoticeWiring {
  register(pi: MemoryExtensionAPI): void
  onCommit(context: MemoryIdentityContext, commit: MemoryToolCommit): void
}

export function createMemoryNoticeWiring(options: MemoryNoticeWiringOptions): MemoryNoticeWiring {
  let api: MemoryExtensionAPI | undefined

  return {
    register(pi): void {
      api = pi
      pi.registerEntryRenderer(SOUL_UPDATED_ENTRY_TYPE, renderSoulUpdatedEntry)
    },
    onCommit(context, commit): void {
      if (api === undefined) return
      if (touchesSoulPath(commit.affectedPaths) && options.resolveEditNotice(context.identity)) {
        api.appendEntry(SOUL_UPDATED_ENTRY_TYPE, {
          sha: commit.sha,
          subject: commit.subject,
          affectedPaths: commit.affectedPaths,
        } satisfies SoulUpdatedRecord)
      }
    },
  }
}
