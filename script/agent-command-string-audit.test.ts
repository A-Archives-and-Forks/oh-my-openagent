/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync, statSync } from "node:fs"
import { resolve } from "node:path"

const WORKSPACE_ROOT = resolve(import.meta.dir, "..")
const ALLOWLIST_PATH = resolve(import.meta.dir, "agent-command-string-audit.allowlist.json")
const AGENT_COMMAND_RE = /\bomo (ulw-loop|boulder)\b/g
const HUMAN_COMMAND_RE = /\bomo (install|uninstall|cleanup|doctor|run|get-local-version|version|mcp)\b/g
const ALLOWLIST_CATEGORIES = ["emit-migrate", "test-expectation", "input-compat-preserve", "docs"] as const

type AllowlistCategory = (typeof ALLOWLIST_CATEGORIES)[number]
type Allowlist = Record<AllowlistCategory, string[]>

function isExcluded(filePath: string): boolean {
  return filePath === "CHANGELOG.md"
    || filePath.endsWith("/CHANGELOG.md")
    || filePath === ".omo"
    || filePath.startsWith(".omo/")
    || filePath.split("/").some((part) => part === "node_modules" || part === "install-dist" || part === "dist")
}

function trackedSourceFiles(): string[] {
  const result = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: WORKSPACE_ROOT, stdout: "pipe", stderr: "pipe" })
  expect(result.exitCode, result.stderr.toString("utf8")).toBe(0)
  return result.stdout.toString("utf8").split("\0").filter((filePath) => {
    const absolutePath = resolve(WORKSPACE_ROOT, filePath)
    return filePath && !isExcluded(filePath) && existsSync(absolutePath) && statSync(absolutePath).isFile()
  })
}

function collectHits(): string[] {
  return trackedSourceFiles().flatMap((filePath) => {
    const source = readFileSync(resolve(WORKSPACE_ROOT, filePath), "utf8")
    return source.split("\n").flatMap((line, lineIndex) => {
      const matches = [AGENT_COMMAND_RE, HUMAN_COMMAND_RE].flatMap((pattern) => Array.from(line.matchAll(pattern), (match) => match[0]))
      return matches.map((match) => `${filePath}:${lineIndex + 1}: ${match}`)
    })
  }).sort()
}

function readAllowlist(): Allowlist {
  return JSON.parse(readFileSync(ALLOWLIST_PATH, "utf8")) as Allowlist
}

describe("agent command string audit", () => {
  test("#given tracked source files #when legacy agent and human commands are scanned #then every hit is categorized", () => {
    const allowlist = readAllowlist()
    expect(Object.keys(allowlist).sort()).toEqual([...ALLOWLIST_CATEGORIES].sort())

    expect(allowlist["emit-migrate"]).toEqual([])
    expect(allowlist["test-expectation"]).toEqual([])

    const categorized = ALLOWLIST_CATEGORIES.flatMap((category) => allowlist[category])
    expect(new Set(categorized).size, "allowlist entries must be unique").toBe(categorized.length)
    expect(collectHits()).toEqual(categorized.sort())
  })
})
