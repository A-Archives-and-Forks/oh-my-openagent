import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8")
const rootConfig = readFileSync(new URL("../bunfig.root.toml", import.meta.url), "utf8")
const win2ConfigPath = new URL("../bunfig.win2.toml", import.meta.url)

function rootTestJob(): string {
  const start = workflow.indexOf("  test:\n")
  const end = workflow.indexOf("\n  typecheck:", start)
  if (start < 0 || end < 0) throw new Error("root test job not found")
  return workflow.slice(start, end)
}

function quotedPatterns(config: string): readonly string[] {
  return [...config.matchAll(/"([^"]+\/\*\*)"/g)].map((match) => match[1] ?? "")
}

describe("root test CI partition", () => {
  test("#given required status check names #when the root matrix is declared #then only os and shard appear", () => {
    const job = rootTestJob()
    const start = job.indexOf("include:")
    const end = job.indexOf("steps:", start)
    const matrix = job.slice(start, end)

    expect(matrix).toContain("- os: ubuntu-latest")
    expect(matrix).toContain("- os: macos-latest")
    expect(matrix).toContain('shard: "1/2"')
    expect(matrix).toContain('shard: "2/2"')
    expect(matrix).not.toContain("config:")
    expect(matrix).not.toContain("test_args:")
    expect(matrix).not.toContain("parallel_args:")
  })

  test("#given global zauc mocks #when Windows root tests are partitioned #then omo-opencode stays in one process", () => {
    const job = rootTestJob()

    expect(job).toContain("bun test packages/omo-opencode packages/memory-core")
    expect(job).toContain("bun --config=bunfig.win2.toml test --parallel")
    expect(existsSync(win2ConfigPath)).toBe(true)
    expect(quotedPatterns(readFileSync(win2ConfigPath, "utf8"))).toContain("packages/omo-opencode/**")
    expect(quotedPatterns(readFileSync(win2ConfigPath, "utf8"))).toContain("packages/memory-core/**")
  })

  test("#given the dedicated Senpi compatibility job #when root tests run #then omo-senpi is excluded on every OS", () => {
    const job = rootTestJob()

    expect(job).toContain("bun --config=bunfig.root.toml test")
    expect(quotedPatterns(rootConfig)).toContain("packages/omo-senpi/**")
    expect(quotedPatterns(readFileSync(win2ConfigPath, "utf8"))).toContain("packages/omo-senpi/**")
  })

  test("#given measured package groups #when the matrix command is rendered #then native file sharding is not used", () => {
    const job = rootTestJob()

    expect(job).not.toContain("--shard=")
    expect(job).not.toContain("--path-ignore-patterns=")
    expect(job).not.toContain("format('-c {0}'")
    expect(job).not.toContain("bun test -c")
  })
})
