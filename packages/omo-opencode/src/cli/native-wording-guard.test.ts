/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url))

const INSTALLER_SOURCE_GLOB = "packages/omo-opencode/src/cli/**/*.ts"

const USER_FACING_FILES = [
  "postinstall.mjs",
  "docs/guide/installation.md",
  "README.md",
  "README.ko.md",
  "README.ja.md",
  "README.ru.md",
  "README.zh-cn.md",
] as const

// Each pattern spells "the edition, named after its engine" in one of the five
// languages the README ships in. No allowlist entry may excuse a match.
const BANNED_EDITION_WORDING: readonly RegExp[] = [
  /senpi[\s-]*(?:native[\s-]*)?edition/i,
  /standalone[\s-]*senpi/i,
  /senpi[\s-]*(?:네이티브\s*)?에디션/i,
  /senpi[\s-]*(?:ネイティブ)?エディション/i,
  /senpi[\s-]*(?:native[\s-]*)?редакци/i,
  /senpi[\s-]*(?:원생|原生)?\s*版本/i,
]

const ENGINE_NAME_ALLOWLIST: readonly { readonly why: string; readonly pattern: RegExp }[] = [
  { why: "engine environment variables", pattern: /SENPI_(?:[A-Z0-9_]+|\*)/g },
  { why: "engine state directory", pattern: /[~\w./-]*\.senpi[\w./-]*/g },
  { why: "internal package paths", pattern: /packages\/(?:omo-senpi|senpi-task)[\w./-]*/g },
  {
    why: "engine and internal package names",
    pattern: /@(?:code-yeongyu|oh-my-opencode)\/(?:omo-)?senpi(?:\/[\w-]+)*/g,
  },
  { why: "reviewer agent ids (public contract)", pattern: /omo-senpi-[a-z-]+/g },
  { why: "omo.json harness view id", pattern: /\[senpi\]/g },
  { why: "the engine named as the engine", pattern: /senpi engine/gi },
  { why: "the doctor edition line", pattern: /engine: ?senpi/gi },
  { why: "engine installer export re-exported by install-native-dev", pattern: /runSenpiInstaller/g },
]

interface Violation {
  readonly file: string
  readonly line: number
  readonly text: string
}

function namesEditionAfterEngine(line: string): boolean {
  return BANNED_EDITION_WORDING.some((pattern) => pattern.test(line))
}

function stripEngineNames(line: string): string {
  let rest = line
  for (const entry of ENGINE_NAME_ALLOWLIST) rest = rest.replace(entry.pattern, "")
  return rest
}

function hasUnallowlistedEngineMention(line: string): boolean {
  return /senpi/i.test(stripEngineNames(line))
}

async function userFacingSources(): Promise<readonly string[]> {
  const installerSources: string[] = []
  for await (const path of new Bun.Glob(INSTALLER_SOURCE_GLOB).scan({ cwd: REPO_ROOT })) {
    if (!path.endsWith(".test.ts")) installerSources.push(path)
  }
  return [...installerSources.sort(), ...USER_FACING_FILES]
}

async function collectViolations(detect: (line: string) => boolean): Promise<readonly Violation[]> {
  const violations: Violation[] = []
  for (const file of await userFacingSources()) {
    const contents = await Bun.file(`${REPO_ROOT}${file}`).text()
    contents.split("\n").forEach((text, index) => {
      if (detect(text)) violations.push({ file, line: index + 1, text: text.trim().slice(0, 140) })
    })
  }
  return violations
}

function report(violations: readonly Violation[]): string[] {
  return violations.map((violation) => `${violation.file}:${violation.line}  ${violation.text}`)
}

describe("user-facing surfaces call the standalone edition OmO Native", () => {
  test("#given every installer, postinstall, docs and README surface #when scanned #then none names the edition after the engine", async () => {
    // given / when
    const violations = await collectViolations(namesEditionAfterEngine)

    // then
    expect(report(violations)).toEqual([])
  })

  test("#given every installer, postinstall, docs and README surface #when scanned #then each remaining senpi mention is an allowlisted engine name", async () => {
    // given / when
    const violations = await collectViolations(hasUnallowlistedEngineMention)

    // then
    expect(report(violations)).toEqual([])
  })
})

describe("the guard itself can fail", () => {
  test.each([
    "**Senpi Edition (standalone, beta)** is the native `omo` command.",
    "a standalone Senpi edition (beta) is available",
    "The senpi-native edition ships as the npm package `omo-ai`.",
    "그 이름은 이제 Senpi 네이티브 에디션의 것입니다.",
    "その名前は Senpi ネイティブエディションのものになりました。",
    "теперь это имя принадлежит senpi-native редакции",
    "这个名字现在归 senpi 原生版本所有",
  ])("#given the banned wording %p #when checked #then it is reported", (line) => {
    // given / when / then
    expect(namesEditionAfterEngine(line)).toBe(true)
  })

  test.each([
    "omo also ships as OmO Native: the same omo as one `omo` command.",
    "Edition: Native · Installed: 5.0.0 (engine: senpi 2026.9.21)",
    "it ships a pinned senpi engine with OMO built in",
    "state under `~/.senpi/agent` when no branded layout exists",
    "chains from `packages/senpi-task/src/agents/builtin/fallback-chains.ts`",
    "harness-specific `[opencode]`, `[senpi]`, and `[codex]` views",
    "the legacy `SENPI_*` and `PI_*` variables are still read when the `OMO_*` one is unset",
  ])("#given the engine-name line %p #when checked #then it is accepted", (line) => {
    // given / when / then
    expect(namesEditionAfterEngine(line)).toBe(false)
    expect(hasUnallowlistedEngineMention(line)).toBe(false)
  })

  test("#given a bare edition mention dressed as prose #when checked #then the allowlist does not excuse it", () => {
    // given
    const line = "Want one command without a host? Choose senpi (beta)."

    // when / then
    expect(hasUnallowlistedEngineMention(line)).toBe(true)
  })
})
