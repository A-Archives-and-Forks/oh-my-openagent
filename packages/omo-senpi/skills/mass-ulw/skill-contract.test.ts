import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { createNativeSkillSources } from "../../plugin/scripts/native-skill-sources.mjs"

const skillDir = dirname(fileURLToPath(import.meta.url))
const skillPath = join(skillDir, "SKILL.md")

type Frontmatter = { readonly name?: string; readonly description?: string }
type CodeBlock = { readonly lang: string; readonly code: string }

function readSkill(): string {
  // An absent SKILL.md is the contract violation under test, not a harness error: report it as
  // empty content so every assertion fails on the missing deliverable itself.
  try {
    return readFileSync(skillPath, "utf8")
  } catch {
    return ""
  }
}

function parseFrontmatter(content: string): Frontmatter {
  const match = content.match(/^---\n([\s\S]*?)\n---\n/)
  if (match === null) return {}
  const fields: Record<string, string> = {}
  for (const line of match[1].split("\n")) {
    const field = line.match(/^(name|description):\s*(.+)$/)
    if (field !== null) fields[field[1]] = field[2].trim()
  }
  return fields
}

function extractCodeBlocks(content: string): readonly CodeBlock[] {
  const blocks: CodeBlock[] = []
  const pattern = /^```(\w+)\n([\s\S]*?)^```$/gm
  for (const match of content.matchAll(pattern)) {
    blocks.push({ lang: match[1], code: match[2] })
  }
  return blocks
}

// The interpreter is named `python3` on POSIX and `python` on Windows runners, so resolve it by
// trying each candidate and keeping the first one that actually spawns. Bun.spawnSync throws
// (rather than returning a non-zero exitCode) when the executable is missing from PATH, so an
// unresolvable name has to be caught here instead of asserted on.
const pythonCandidates = ["python3", "python"] as const

type AstParseResult = { readonly command: string; readonly exitCode: number }

function astParsePython(code: string): AstParseResult {
  const failures: string[] = []
  for (const command of pythonCandidates) {
    try {
      const proc = Bun.spawnSync([command, "-c", "import ast, sys; ast.parse(sys.stdin.read())"], {
        stdin: new TextEncoder().encode(code),
      })
      return { command, exitCode: proc.exitCode }
    } catch (error) {
      failures.push(`${command}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(`no python interpreter found (tried ${pythonCandidates.join(", ")}): ${failures.join("; ")}`)
}

// Minimal ESM stub of the todo-27 SDK surface: define collects nodes (rejecting duplicate ids),
// every other export delegates to globalThis.tool.dag with the matching action.
const sdkStubSource = `
export function define({ key, name }) {
  const nodes = []
  const seen = new Set()
  return {
    key,
    name,
    nodes,
    node(input) {
      if (seen.has(input.id)) throw new Error("duplicate node id: " + input.id)
      seen.add(input.id)
      nodes.push(input)
      return this
    },
  }
}
export function start(definition) {
  return globalThis.tool.dag({
    action: "start",
    definition: { key: definition.key, name: definition.name, nodes: definition.nodes },
  })
}
export function attach(run_id) {
  return globalThis.tool.dag({ action: "attach", run_id })
}
export function snapshot(run_id) {
  return globalThis.tool.dag({ action: "snapshot", run_id })
}
export function wait(run_id) {
  return globalThis.tool.dag({ action: "wait", run_id })
}
export function cancel(run_id, reason) {
  return globalThis.tool.dag({ action: "cancel", run_id, reason })
}
`

type DagCall = { readonly action: string; readonly definition?: DagDefinitionArg; readonly run_id?: string }
type DagNodeArg = {
  readonly id: string
  readonly prompt: string
  readonly category?: string
  readonly dependsOn?: readonly string[]
}
type DagDefinitionArg = { readonly key: string; readonly name: string; readonly nodes: readonly DagNodeArg[] }

function createDagStub(calls: DagCall[]): (params: DagCall) => Promise<Record<string, unknown>> {
  return async (params) => {
    calls.push(params)
    if (params.action === "start") {
      return { run_id: "run_stub_1", reused: false, status: "running" }
    }
    if (params.action === "wait") {
      return { run_id: params.run_id, status: "completed", nodes: {} }
    }
    return { run_id: params.run_id, status: "running" }
  }
}

describe("mass-ulw SKILL.md contract", () => {
  describe("#given the skill frontmatter", () => {
    test("#when parsed #then name and description are present and well-formed", () => {
      // given
      const frontmatter = parseFrontmatter(readSkill())
      // then
      expect(frontmatter.name).toBe("mass-ulw")
      expect(frontmatter.description).toBeDefined()
      expect((frontmatter.description ?? "").length).toBeGreaterThan(20)
    })

    test("#when scanned for selection concepts #then the description names none", () => {
      // given
      const frontmatter = parseFrontmatter(readSkill())
      // then
      expect(frontmatter.description ?? "").not.toMatch(/model/i)
    })
  })

  describe("#given every fenced code block", () => {
    const blocks = extractCodeBlocks(readSkill())

    test("#when collected #then js and python examples both exist", () => {
      // then
      expect(blocks.length).toBeGreaterThan(0)
      expect(blocks.some((block) => block.lang === "js")).toBe(true)
      expect(blocks.some((block) => block.lang === "python")).toBe(true)
    })

    test("#when scanned #then no block carries a model property and every node routes by category", () => {
      for (const block of blocks) {
        // then
        expect(block.code).not.toMatch(/["']?\bmodel\b["']?\s*:/)
        expect(block.code).not.toMatch(/\bsubagent_type\b/)
      }
      const nodeBlocks = blocks.filter((block) => /"?\bid\b"?\s*:/.test(block.code))
      expect(nodeBlocks.length).toBeGreaterThan(0)
      for (const block of nodeBlocks) {
        expect(block.code).toMatch(/["']?category["']?\s*:/)
      }
    })

    test("#when js blocks are transpiled #then each is syntactically valid", () => {
      // given
      const transpiler = new Bun.Transpiler({ loader: "js" })
      for (const block of blocks.filter((candidate) => candidate.lang === "js")) {
        // then: transform throws on syntax errors
        expect(() => transpiler.transformSync(block.code)).not.toThrow()
      }
    })

    test("#when python blocks are ast-parsed #then each is syntactically valid", () => {
      for (const block of blocks.filter((candidate) => candidate.lang === "python")) {
        // when
        const result = astParsePython(block.code)
        // then
        expect(result.exitCode).toBe(0)
      }
      // 60s: this test spawns a real Python interpreter, whose first-invocation cold start on
      // Windows CI runners (~7-8s) blows the default 5s budget. Matches the repo's established
      // ceiling for process-spawning tests (c75092aed).
    }, 60_000)
  })

  describe("#given the js examples executed against the todo-27 SDK stub", () => {
    let sdkRoot: string
    let calls: DagCall[]
    const globalWithTool = globalThis as { tool?: { dag: (params: DagCall) => Promise<Record<string, unknown>> } }
    let previousTool: (typeof globalWithTool)["tool"]

    beforeEach(() => {
      sdkRoot = mkdtempSync(join(tmpdir(), "mass-ulw-sdk-"))
      writeFileSync(join(sdkRoot, "sdk.js"), sdkStubSource)
      calls = []
      previousTool = globalWithTool.tool
      globalWithTool.tool = { dag: createDagStub(calls) }
    })

    afterEach(() => {
      globalWithTool.tool = previousTool
      rmSync(sdkRoot, { recursive: true, force: true })
    })

    test("#when each js block runs #then every dag call the SDK issues is valid against the real tool surface", async () => {
      // given
      const jsBlocks = extractCodeBlocks(readSkill()).filter((block) => block.lang === "js")
      const env = (key: string): string => {
        expect(key).toBe("OMO_DAG_SDK_ROOT")
        return sdkRoot
      }
      for (const block of jsBlocks) {
        // when
        const run = new Function("env", `return (async () => {\n${block.code}\n})()`)
        await run(env)
      }
      // then
      const starts = calls.filter((call) => call.action === "start")
      expect(starts.length).toBeGreaterThan(0)
      for (const start of starts) {
        const definition = start.definition
        expect(definition).toBeDefined()
        if (definition === undefined) continue
        expect(typeof definition.key).toBe("string")
        expect(typeof definition.name).toBe("string")
        const ids = new Set(definition.nodes.map((node) => node.id))
        for (const node of definition.nodes) {
          expect(typeof node.prompt).toBe("string")
          expect(typeof node.category).toBe("string")
          for (const dep of node.dependsOn ?? []) {
            expect(ids.has(dep)).toBe(true)
          }
        }
      }
      // the happy-path QA scenario: at least one start carries a 3+ node graph with a dependency
      const graph = starts.find((call) => (call.definition?.nodes.length ?? 0) >= 3)
      expect(graph).toBeDefined()
      expect(graph?.definition?.nodes.some((node) => (node.dependsOn?.length ?? 0) > 0)).toBe(true)
      // lifecycle actions the skill teaches must resolve to real tool actions
      const actions = new Set(calls.map((call) => call.action))
      for (const action of actions) {
        expect(["start", "attach", "snapshot", "wait", "cancel"]).toContain(action)
      }
    })

    test("#when each python block's tool.dag payloads are checked #then they are valid tool inputs", () => {
      // given: python cannot import ESM, so blocks call tool.dag directly with dict literals that
      // are also valid JSON once parsed; extract each dict argument and validate its shape.
      const pythonBlocks = extractCodeBlocks(readSkill()).filter((block) => block.lang === "python")
      let checked = 0
      for (const block of pythonBlocks) {
        for (const match of block.code.matchAll(/tool\.dag\(([\s\S]*?)\)\n/g)) {
          const literal = match[1].replace(/\brun\["run_id"\]/g, '"run_stub_1"')
          const payload = JSON.parse(literal) as DagCall
          checked += 1
          // then
          expect(["start", "attach", "snapshot", "wait", "cancel"]).toContain(payload.action)
          if (payload.action === "start") {
            expect(payload.definition).toBeDefined()
            for (const node of payload.definition?.nodes ?? []) {
              expect(typeof node.id).toBe("string")
              expect(typeof node.prompt).toBe("string")
              expect(typeof node.category).toBe("string")
            }
          } else {
            expect(typeof payload.run_id).toBe("string")
          }
        }
      }
      expect(checked).toBeGreaterThan(0)
    })
  })

  describe("#given the skill sync registry", () => {
    test("#when native skill sources are built #then mass-ulw is registered and points at this directory", () => {
      // when
      const repoRoot = join(skillDir, "..", "..", "..")
      const { sources, names } = createNativeSkillSources(repoRoot) as {
        sources: readonly { name: string; source: string }[]
        names: Set<string>
      }
      // then
      expect(names.has("mass-ulw")).toBe(true)
      const entry = sources.find((candidate) => candidate.name === "mass-ulw")
      expect(entry?.source).toBe(skillDir)
    })
  })
})
