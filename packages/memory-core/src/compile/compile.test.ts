import { afterEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GitMemoryRepo } from "../git"
import {
  MEMORY_NUDGE_METADATA_TOKEN,
  MEMORY_SOUL_METADATA_TOKEN,
  compileMemoryBlock,
} from "./compile"

const tempDirs: string[] = []
const NOW = new Date("2026-05-04T00:00:00.000Z")

interface CompiledBlockStructure {
  readonly sections: readonly string[]
  readonly projectionPaths: readonly string[]
  readonly memoryOpenTags: readonly string[]
  readonly metadata: {
    readonly agentId: string
    readonly conversationId: string
    readonly compiledAt: string
    readonly previousMessageCount: number
    readonly nudgeTurns?: number
    readonly soulSha?: string
  }
}

function parseCompiledBlock(block: string): CompiledBlockStructure {
  const sections = [...block.matchAll(/^<(self|memory|memory_metadata)>$/gm)].map((match) => match[1] ?? "")
  for (const section of sections) {
    const openings = [...block.matchAll(new RegExp(`^<${section}>$`, "gm"))]
    const closings = [...block.matchAll(new RegExp(`^</${section}>$`, "gm"))]
    const start = openings[0]?.index ?? -1
    const end = closings[0]?.index ?? -1
    if (openings.length !== 1 || closings.length !== 1 || end <= start) {
      throw new Error(`invalid compiled section: ${section}`)
    }
  }

  const projectionPaths = [...block.matchAll(/<projection>\$MEMORY_DIR\/([^<]+)<\/projection>/g)]
    .map((match) => match[1] ?? "")
  const memory = region(block, "memory")
  const memoryOpenTags = memory === undefined
    ? []
    : [...memory.matchAll(/^\s*<([a-z][a-z0-9_-]*)>$/gm)].map((match) => match[1] ?? "")
  const metadata = requiredRegion(block, "memory_metadata")
  const agentId = requiredMatch(metadata, /^- AGENT_ID: (.+)$/m)
  const conversationId = requiredMatch(metadata, /^- CONVERSATION_ID: (.+)$/m)
  const compiledAt = requiredMatch(metadata, /(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} (?:AM|PM) UTC[+-]\d{4})/)
  const previousMessageCount = Number(requiredMatch(metadata, /^- (\d+) previous messages\b/m))
  const nudgeMatch = metadata.match(new RegExp(`^- (\\d+) ${escapeRegExp(MEMORY_NUDGE_METADATA_TOKEN)}\\b`, "m"))
  const soulMatch = metadata.match(new RegExp(`^- ${escapeRegExp(MEMORY_SOUL_METADATA_TOKEN)} reflection ([a-f0-9]{7})\\b`, "m"))

  return {
    sections,
    projectionPaths,
    memoryOpenTags,
    metadata: {
      agentId,
      conversationId,
      compiledAt,
      previousMessageCount,
      ...(nudgeMatch?.[1] === undefined ? {} : { nudgeTurns: Number(nudgeMatch[1]) }),
      ...(soulMatch?.[1] === undefined ? {} : { soulSha: soulMatch[1] }),
    },
  }
}

function region(block: string, tag: string): string | undefined {
  const match = block.match(new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`))
  return match?.[1]
}

function requiredRegion(block: string, tag: string): string {
  const value = region(block, tag)
  if (value === undefined) throw new Error(`missing compiled section: ${tag}`)
  return value
}

function requiredMatch(input: string, pattern: RegExp): string {
  const value = input.match(pattern)?.[1]
  if (value === undefined) throw new Error(`missing compiled field: ${pattern.source}`)
  return value
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

async function repoWith(files: Array<{ relativePath: string; content: string }>) {
  const dir = await mkdtemp(join(tmpdir(), "memory-compile-"))
  tempDirs.push(dir)
  const repo = new GitMemoryRepo({ dir, agentId: "fixture-agent" })
  await repo.init({ seedFiles: files })
  return { dir, repo }
}

function memory(description: string, body: string): string {
  return `---\ndescription: ${description}\n---\n${body}`
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("compileMemoryBlock", () => {
  it("#given nested committed memory #when compiled #then block sections, projection order, and metadata values form the structural contract", async () => {
    // given
    const { repo } = await repoWith([
      { relativePath: "system/persona.md", content: memory("PERSONA_DESCRIPTION", "PERSONA_BODY\n") },
      { relativePath: "system/facts.md", content: memory("FACTS_DESCRIPTION", "FACTS_BODY\n") },
      { relativePath: "system/human/prefs/coding.md", content: memory("PREFS_DESCRIPTION", "PREFS_BODY\n") },
      { relativePath: "reference/details.md", content: memory("REFERENCE_DESCRIPTION", "EXTERNAL_BODY_SENTINEL\n") },
      { relativePath: "archive/diagram.png", content: "BINARY_BODY_SENTINEL" },
      { relativePath: "README.MD", content: "UPPERCASE_BODY_SENTINEL" },
      { relativePath: "skills/deploy/SKILL.md", content: memory("SKILL_DESCRIPTION", "SKILL_BODY_SENTINEL\n") },
    ])

    // when
    const block = await compileMemoryBlock(repo, {
      agentId: "agent-golden",
      conversationId: "conversation-golden",
      previousMessageCount: 7,
      clock: () => NOW,
    })
    const structure = parseCompiledBlock(block)

    // then
    expect(structure).toEqual({
      sections: ["self", "memory", "memory_metadata"],
      projectionPaths: ["system/persona.md", "system/facts.md", "system/human/prefs/coding.md"],
      memoryOpenTags: ["facts", "human", "prefs", "coding", "external_projection"],
      metadata: {
        agentId: "agent-golden",
        conversationId: "conversation-golden",
        compiledAt: "2026-05-04 12:00:00 AM UTC+0000",
        previousMessageCount: 7,
      },
    })
    expect(block).toContain("PERSONA_BODY")
    expect(block).toContain("FACTS_BODY")
    expect(block).toContain("PREFS_BODY")
    expect(block).not.toContain("EXTERNAL_BODY_SENTINEL")
    expect(block).not.toContain("BINARY_BODY_SENTINEL")
    expect(block).not.toContain("SKILL_BODY_SENTINEL")
  })

  it("#given a committed persona and identity #when compiled #then both projection paths share the self section and metadata remains structured", async () => {
    // given
    const { repo } = await repoWith([
      { relativePath: "system/persona.md", content: memory("PERSONA_DESCRIPTION", "PERSONA_BODY\n") },
      { relativePath: "system/identity.md", content: memory("IDENTITY_DESCRIPTION", "IDENTITY_BODY\n") },
      { relativePath: "system/facts.md", content: memory("FACTS_DESCRIPTION", "FACTS_BODY\n") },
    ])

    // when
    const block = await compileMemoryBlock(repo, {
      agentId: "persona-identity-agent",
      conversationId: "persona-identity-conversation",
      previousMessageCount: 2,
      clock: () => NOW,
    })
    const structure = parseCompiledBlock(block)

    // then
    expect(structure).toEqual({
      sections: ["self", "memory", "memory_metadata"],
      projectionPaths: ["system/persona.md", "system/identity.md", "system/facts.md"],
      memoryOpenTags: ["facts"],
      metadata: {
        agentId: "persona-identity-agent",
        conversationId: "persona-identity-conversation",
        compiledAt: "2026-05-04 12:00:00 AM UTC+0000",
        previousMessageCount: 2,
      },
    })
  })

  it("#given only a committed identity #when compiled #then it renders under self without a persona projection", async () => {
    // given
    const { repo } = await repoWith([
      { relativePath: "system/identity.md", content: memory("IDENTITY_DESCRIPTION", "IDENTITY_BODY\n") },
    ])

    // when
    const block = await compileMemoryBlock(repo, {
      agentId: "identity-agent",
      conversationId: "identity-conversation",
      previousMessageCount: 0,
      clock: () => NOW,
    })
    const structure = parseCompiledBlock(block)

    // then
    expect(structure.sections).toEqual(["self", "memory_metadata"])
    expect(structure.projectionPaths).toEqual(["system/identity.md"])
  })

  it("#given an empty committed repository #when compiled #then only structured metadata is emitted", async () => {
    // given
    const { repo } = await repoWith([])

    // when
    const block = await compileMemoryBlock(repo, {
      agentId: "empty-agent",
      conversationId: "empty-conversation",
      previousMessageCount: 0,
      clock: () => NOW,
    })
    const structure = parseCompiledBlock(block)

    // then
    expect(structure).toEqual({
      sections: ["memory_metadata"],
      projectionPaths: [],
      memoryOpenTags: [],
      metadata: {
        agentId: "empty-agent",
        conversationId: "empty-conversation",
        compiledAt: "2026-05-04 12:00:00 AM UTC+0000",
        previousMessageCount: 0,
      },
    })
  })

  it("#given only a committed persona #when compiled #then its body is projected without its description", async () => {
    // given
    const { repo } = await repoWith([
      { relativePath: "system/persona.md", content: memory("DESCRIPTION_SENTINEL", "PERSONA_BODY_SENTINEL\n") },
    ])

    // when
    const block = await compileMemoryBlock(repo, {
      agentId: "persona-agent",
      conversationId: "persona-conversation",
      previousMessageCount: 2,
      clock: () => NOW,
    })
    const structure = parseCompiledBlock(block)

    // then
    expect(structure.sections).toEqual(["self", "memory_metadata"])
    expect(structure.projectionPaths).toEqual(["system/persona.md"])
    expect(block).toContain("PERSONA_BODY_SENTINEL")
    expect(block).not.toContain("DESCRIPTION_SENTINEL")
  })

  it("#given nudge turns #when compiled #then parsed metadata carries the nudge token value only when requested", async () => {
    // given
    const { repo } = await repoWith([])

    // when
    const nudged = parseCompiledBlock(await compileMemoryBlock(repo, {
      agentId: "nudge-agent",
      conversationId: "nudge-conversation",
      previousMessageCount: 2,
      nudgeTurns: 2,
      clock: () => NOW,
    }))
    const quiet = parseCompiledBlock(await compileMemoryBlock(repo, {
      agentId: "nudge-agent",
      conversationId: "nudge-conversation",
      previousMessageCount: 2,
      clock: () => NOW,
    }))

    // then
    expect(nudged.metadata.nudgeTurns).toBe(2)
    expect(quiet.metadata.nudgeTurns).toBeUndefined()
  })

  it("#given a soul notice #when compiled #then parsed metadata carries the short sha only for that compile", async () => {
    // given
    const { repo } = await repoWith([])
    const sha = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"

    // when
    const noticed = parseCompiledBlock(await compileMemoryBlock(repo, {
      agentId: "soul-agent",
      conversationId: "soul-conversation",
      previousMessageCount: 2,
      soulNotice: { sha },
      clock: () => NOW,
    }))
    const quiet = parseCompiledBlock(await compileMemoryBlock(repo, {
      agentId: "soul-agent",
      conversationId: "soul-conversation",
      previousMessageCount: 2,
      clock: () => NOW,
    }))

    // then
    expect(noticed.metadata.soulSha).toBe(sha.slice(0, 7))
    expect(quiet.metadata.soulSha).toBeUndefined()
  })

  it("#given a dirty persona edit #when compiled #then only the committed HEAD body sentinel appears", async () => {
    // given
    const { dir, repo } = await repoWith([
      { relativePath: "system/persona.md", content: memory("PERSONA", "COMMITTED_BODY_SENTINEL\n") },
    ])
    await writeFile(join(dir, "system/persona.md"), memory("PERSONA", "DIRTY_BODY_SENTINEL\n"))

    // when
    const block = await compileMemoryBlock(repo, {
      agentId: "persona-agent",
      conversationId: "persona-conversation",
      previousMessageCount: 2,
      clock: () => NOW,
    })

    // then
    expect(block).toContain("COMMITTED_BODY_SENTINEL")
    expect(block).not.toContain("DIRTY_BODY_SENTINEL")
  })

  it("#given a committed binary projection #when compiled #then its path is listed without reading its blob", async () => {
    // given
    const { repo } = await repoWith([{ relativePath: "assets/logo.png", content: "BINARY_BODY_SENTINEL" }])
    const originalShow = repo.show.bind(repo)
    repo.show = async (revision, path) => {
      if (path.endsWith(".png")) throw new Error("binary blob was read")
      return originalShow(revision, path)
    }

    // when
    const block = await compileMemoryBlock(repo, {
      agentId: "binary-agent",
      conversationId: "binary-conversation",
      previousMessageCount: 0,
      clock: () => NOW,
    })
    const structure = parseCompiledBlock(block)

    // then
    expect(structure.sections).toEqual(["memory", "memory_metadata"])
    expect(structure.memoryOpenTags).toEqual(["external_projection"])
    expect(block).toContain("logo.png")
    expect(block).not.toContain("BINARY_BODY_SENTINEL")
  })

  it("#given an unreadable committed system file #when compiled #then its structural tag is skipped best-effort", async () => {
    // given
    const { repo } = await repoWith([
      { relativePath: "system/persona.md", content: memory("PERSONA", "READABLE_BODY_SENTINEL\n") },
      { relativePath: "system/broken.md", content: "missing frontmatter" },
    ])

    // when
    const block = await compileMemoryBlock(repo, {
      agentId: "skip-agent",
      conversationId: "skip-conversation",
      previousMessageCount: 0,
      clock: () => NOW,
    })
    const structure = parseCompiledBlock(block)

    // then
    expect(structure.sections).toEqual(["self", "memory_metadata"])
    expect(structure.projectionPaths).toEqual(["system/persona.md"])
    expect(block).toContain("READABLE_BODY_SENTINEL")
  })
})
