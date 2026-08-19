import { afterEach, describe, expect, test } from "bun:test"
import { access, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { realpathSync } from "node:fs"

import type { ThemeColor } from "@code-yeongyu/senpi"
import { buildIdentityPaths } from "@oh-my-opencode/memory-core"

import { createMemoryBinding } from "./binding"
import { createMemoryIdentityContext, type MemoryIdentityContext } from "./context"
import { MemoryFakeExtensionAPI } from "./memory.test-support"
import { SOUL_UPDATED_ENTRY_TYPE, createSoulNoticeWiring, renderSoulUpdatedEntry } from "./soul-notice"
import { toolReceiptPath, writeToolReceipt } from "./tool-receipts"

const IDENTITY = "soul-notice-agent"
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })))
})

async function fixture(): Promise<{ context: MemoryIdentityContext }> {
  const root = realpathSync.native(await mkdtemp(join(tmpdir(), "omo-soul-notice-")))
  roots.push(root)
  const identityPaths = buildIdentityPaths(root, IDENTITY)
  const context = createMemoryIdentityContext({
    identity: IDENTITY,
    identityPaths,
    binding: createMemoryBinding({ identity: IDENTITY, repoPath: identityPaths.repo, boundAt: 1 }),
  })
  return { context }
}

function eventContext(sessionId: string): unknown {
  return { sessionManager: { getSessionId: () => sessionId } }
}

const SOUL_COMMIT = {
  sha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
  subject: "rewrite my persona",
  affectedPaths: ["system/persona.md"],
}
const SOUL_SHA7 = SOUL_COMMIT.sha.slice(0, 7)

const BOLD = "\u001b[1m"
const BOLD_OFF = "\u001b[22m"
function bold(text: string): string {
  return `${BOLD}${text}${BOLD_OFF}`
}

const PLAIN_THEME = {
  fg: (_color: ThemeColor, text: string) => text,
  italic: (text: string) => text,
}

function recordingTheme(): {
  readonly theme: { fg: (color: ThemeColor, text: string) => string; italic: (text: string) => string }
  readonly colors: ThemeColor[]
  readonly italics: string[]
} {
  const colors: ThemeColor[] = []
  const italics: string[] = []
  return {
    theme: {
      fg: (color: ThemeColor, text: string) => {
        colors.push(color)
        return text
      },
      italic: (text: string) => {
        italics.push(text)
        return text
      },
    },
    colors,
    italics,
  }
}

function renderSoul(
  data: typeof SOUL_COMMIT | undefined,
  options: { readonly expanded?: boolean; readonly theme?: unknown } = {},
): string[] {
  const component = renderSoulUpdatedEntry(
    { data } as never,
    { expanded: options.expanded ?? false },
    (options.theme ?? PLAIN_THEME) as never,
  )
  expect(component).toBeDefined()
  return component!.render(120)
}

describe("createSoulNoticeWiring onCommit", () => {
  test("#given edit_notice enabled #when a soul commit arrives #then exactly one soul-updated entry is appended with the commit metadata", async () => {
    // given
    const { context } = await fixture()
    const pi = new MemoryFakeExtensionAPI()
    const wiring = createSoulNoticeWiring({
      resolveContext: () => context,
      resolveEditNotice: () => true,
    })
    wiring.register(pi)

    // when
    wiring.onCommit(context, SOUL_COMMIT)

    // then
    expect(pi.entries).toEqual([{ customType: SOUL_UPDATED_ENTRY_TYPE, data: SOUL_COMMIT }])
  })

  test("#given edit_notice enabled #when a non-soul commit arrives #then no entry is appended", async () => {
    // given
    const { context } = await fixture()
    const pi = new MemoryFakeExtensionAPI()
    const wiring = createSoulNoticeWiring({
      resolveContext: () => context,
      resolveEditNotice: () => true,
    })
    wiring.register(pi)

    // when
    wiring.onCommit(context, { ...SOUL_COMMIT, affectedPaths: ["notes/facts/2026-08.md"] })

    // then
    expect(pi.entries).toHaveLength(0)
  })

  test("#given edit_notice disabled #when a soul commit arrives #then no visible entry is appended", async () => {
    // given
    const { context } = await fixture()
    const pi = new MemoryFakeExtensionAPI()
    const wiring = createSoulNoticeWiring({
      resolveContext: () => context,
      resolveEditNotice: () => false,
    })
    wiring.register(pi)

    // when
    wiring.onCommit(context, SOUL_COMMIT)

    // then
    expect(pi.entries).toHaveLength(0)
  })

  test("#given registration #when the component registers #then a renderer is registered for the soul-updated entry type", async () => {
    // given
    const { context } = await fixture()
    const pi = new MemoryFakeExtensionAPI()
    const wiring = createSoulNoticeWiring({
      resolveContext: () => context,
      resolveEditNotice: () => true,
    })

    // when
    wiring.register(pi)

    // then
    expect(pi.entryRenderers.map((registration) => registration.customType)).toContain(SOUL_UPDATED_ENTRY_TYPE)
  })
})

describe("createSoulNoticeWiring tool_result receipts", () => {
  test("#given a receipt for the event toolCallId #when tool_result fires #then one entry is appended and the receipt is consumed", async () => {
    // given
    const { context } = await fixture()
    const pi = new MemoryFakeExtensionAPI()
    const wiring = createSoulNoticeWiring({
      resolveContext: () => context,
      resolveEditNotice: () => true,
    })
    wiring.register(pi)
    await writeToolReceipt(context.identityPaths.toolReceipts, {
      version: 1,
      toolCallId: "call-9",
      ...SOUL_COMMIT,
    })

    // when
    await pi.dispatch("tool_result", {
      type: "tool_result",
      toolName: "mcp_omo-memory_memory",
      toolCallId: "call-9",
      input: {},
      content: [],
      isError: false,
    }, eventContext("session-1"))

    // then
    expect(pi.entries).toEqual([{ customType: SOUL_UPDATED_ENTRY_TYPE, data: SOUL_COMMIT }])
    expect(await exists(toolReceiptPath(context.identityPaths.toolReceipts, "call-9"))).toBe(false)
  })

  test("#given a receipt whose embedded toolCallId does not match the event #when tool_result fires #then no entry is appended and the receipt is consumed", async () => {
    // given
    const { context } = await fixture()
    const pi = new MemoryFakeExtensionAPI()
    const wiring = createSoulNoticeWiring({
      resolveContext: () => context,
      resolveEditNotice: () => true,
    })
    wiring.register(pi)
    await writeToolReceipt(context.identityPaths.toolReceipts, {
      version: 1,
      toolCallId: "call-other",
      ...SOUL_COMMIT,
    })
    const forged = toolReceiptPath(context.identityPaths.toolReceipts, "call-9")
    await writeFile(forged, `${JSON.stringify({ version: 1, toolCallId: "call-other", ...SOUL_COMMIT })}\n`, "utf8")

    // when
    await pi.dispatch("tool_result", {
      type: "tool_result",
      toolName: "mcp_omo-memory_memory",
      toolCallId: "call-9",
      input: {},
      content: [],
      isError: false,
    }, eventContext("session-1"))

    // then
    expect(pi.entries).toHaveLength(0)
    expect(await exists(forged)).toBe(false)
  })

  test("#given no receipt on disk #when tool_result fires #then nothing is appended and nothing throws", async () => {
    // given
    const { context } = await fixture()
    const pi = new MemoryFakeExtensionAPI()
    const wiring = createSoulNoticeWiring({
      resolveContext: () => context,
      resolveEditNotice: () => true,
    })
    wiring.register(pi)

    // when
    await pi.dispatch("tool_result", {
      type: "tool_result",
      toolName: "mcp_omo-memory_memory",
      toolCallId: "call-absent",
      input: {},
      content: [],
      isError: false,
    }, eventContext("session-1"))

    // then
    expect(pi.entries).toHaveLength(0)
  })

  test("#given a non-memory tool result #when tool_result fires #then receipts are left untouched", async () => {
    // given
    const { context } = await fixture()
    const pi = new MemoryFakeExtensionAPI()
    const wiring = createSoulNoticeWiring({
      resolveContext: () => context,
      resolveEditNotice: () => true,
    })
    wiring.register(pi)
    await writeToolReceipt(context.identityPaths.toolReceipts, {
      version: 1,
      toolCallId: "call-9",
      ...SOUL_COMMIT,
    })

    // when
    await pi.dispatch("tool_result", {
      type: "tool_result",
      toolName: "bash",
      toolCallId: "call-9",
      input: {},
      content: [],
      isError: false,
    }, eventContext("session-1"))

    // then
    expect(pi.entries).toHaveLength(0)
    expect(await exists(toolReceiptPath(context.identityPaths.toolReceipts, "call-9"))).toBe(true)
  })
})

describe("renderSoulUpdatedEntry house notice contract", () => {
  test("#given a persona soul commit #when it renders collapsed #then the title carries the glyph and sha7 and the why names the file", () => {
    // when
    const lines = renderSoul(SOUL_COMMIT)

    // then
    expect(lines[0]).toBe(bold(`● Memory soul updated · ${SOUL_SHA7}`))
    expect(lines[0]).toContain("●")
    expect(lines[0]).toContain(SOUL_SHA7)
    expect(lines[1]).toContain("system/persona.md")
    expect(lines.join("\n")).not.toContain(SOUL_COMMIT.sha)
  })

  test("#when it renders collapsed #then each affected path is a visible extra line and the detail is omitted", () => {
    // when
    const lines = renderSoul(SOUL_COMMIT)

    // then
    expect(lines).toEqual([
      bold(`● Memory soul updated · ${SOUL_SHA7}`),
      "The soul file system/persona.md changed.",
      "system/persona.md",
    ])
    expect(lines.join("\n")).not.toContain(SOUL_COMMIT.sha)
    expect(lines.join("\n")).not.toContain(SOUL_COMMIT.subject)
  })

  test("#when it renders expanded #then the detail row carries the full sha and subject", () => {
    // when
    const lines = renderSoul(SOUL_COMMIT, { expanded: true })

    // then
    expect(lines.at(-1)).toBe(`${SOUL_COMMIT.sha} · ${SOUL_COMMIT.subject}`)
    expect(lines.join("\n")).toContain(SOUL_COMMIT.sha)
  })

  test("#given persona and identity #when it renders #then the why names both soul files", () => {
    // when
    const lines = renderSoul({
      ...SOUL_COMMIT,
      affectedPaths: ["system/identity.md", "system/persona.md"],
    })

    // then
    expect(lines[1]).toContain("system/persona.md")
    expect(lines[1]).toContain("system/identity.md")
    expect(lines.slice(2)).toEqual(["system/identity.md", "system/persona.md"])
  })

  test("#given identity plus a non-soul path #when it renders #then the why names only the soul file", () => {
    // when
    const lines = renderSoul({
      ...SOUL_COMMIT,
      affectedPaths: ["system/identity.md", "reference/old-persona.md"],
    })

    // then
    expect(lines[1]).toContain("system/identity.md")
    expect(lines[1]).not.toContain("reference/old-persona.md")
    expect(lines.slice(2)).toEqual(["system/identity.md", "reference/old-persona.md"])
  })

  test("#when coloured #then the title is accent and the secondary rows are dim", () => {
    // given
    const recorder = recordingTheme()

    // when
    renderSoul(SOUL_COMMIT, { expanded: true, theme: recorder.theme })

    // then
    expect(recorder.colors).toEqual(["accent", "dim", "dim", "dim"])
    expect(recorder.italics).toHaveLength(1)
  })

  test("#given no record #when it renders #then it returns undefined", () => {
    expect(
      renderSoulUpdatedEntry({} as never, { expanded: false }, PLAIN_THEME as never),
    ).toBeUndefined()
  })
})

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
