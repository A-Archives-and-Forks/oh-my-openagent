import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { parseJsonc } from "../../shared/jsonc-parser"
import { CONFIG_BASENAME, LEGACY_CONFIG_BASENAME } from "../../shared/plugin-identity"
import type { InstallConfig } from "../types"
import { resetConfigContext } from "./config-context"
import { generateOmoConfig } from "./generate-omo-config"
import { writeOmoConfig } from "./write-omo-config"

const installConfig: InstallConfig = {
  hasClaude: true,
  isMax20: true,
  hasOpenAI: true,
  hasGemini: true,
  hasCopilot: false,
  hasOpencodeZen: false,
  hasZaiCodingPlan: false,
  hasKimiForCoding: false,
  hasOpencodeGo: false,
      hasBailianCodingPlan: false,
  hasVercelAiGateway: false,
}

function getRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }

  return {}
}

describe("writeOmoConfig", () => {
  let originalHome: string | undefined
  let testConfigDir = ""
  let testConfigPath = ""

  beforeEach(() => {
    testConfigDir = join(tmpdir(), `omo-write-config-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    testConfigPath = join(testConfigDir, ".omo", "omo.jsonc")
    originalHome = process.env.HOME

    mkdirSync(testConfigDir, { recursive: true })
    process.env.HOME = testConfigDir
    process.env.OPENCODE_CONFIG_DIR = testConfigDir
    resetConfigContext()
  })

  afterEach(() => {
    rmSync(testConfigDir, { recursive: true, force: true })
    resetConfigContext()
    delete process.env.OPENCODE_CONFIG_DIR
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
  })

  it("preserves existing user values while adding new defaults", () => {
    // given
    const existingConfig = {
      agents: {
        sisyphus: {
          model: "custom/provider-model",
        },
      },
      disabled_hooks: ["comment-checker"],
    }
    mkdirSync(join(testConfigDir, ".omo"), { recursive: true })
    writeFileSync(testConfigPath, JSON.stringify({ "[opencode]": existingConfig }, null, 2) + "\n", "utf-8")

    const generatedDefaults = generateOmoConfig(installConfig)

    // when
    const result = writeOmoConfig(installConfig)

    // then
    expect(result.success).toBe(true)

    const savedDocument = parseJsonc<Record<string, unknown>>(readFileSync(testConfigPath, "utf-8"))
    const savedConfig = getRecord(savedDocument["[opencode]"])
    const savedAgents = getRecord(savedConfig.agents)
    const savedSisyphus = getRecord(savedAgents.sisyphus)
    expect(savedSisyphus.model).toBe("custom/provider-model")
    expect(savedConfig.disabled_hooks).toEqual(["comment-checker"])

    for (const defaultKey of Object.keys(generatedDefaults)) {
      expect(savedConfig).toHaveProperty(defaultKey)
    }
  })

  it("writes generated settings into the unified user [opencode] block without default profiles", () => {
    // given
    const initialHome = process.env.HOME
    const homeDir = join(testConfigDir, "home")
    const legacyPath = join(homeDir, ".config", "opencode", "oh-my-openagent.json")
    const unifiedPath = join(homeDir, ".omo", "omo.jsonc")
    mkdirSync(join(homeDir, ".config", "opencode"), { recursive: true })
    writeFileSync(legacyPath, JSON.stringify({ agents: { oracle: { model: "anthropic/legacy" } } }))
    process.env.HOME = homeDir

    try {
      // when
      const result = writeOmoConfig(installConfig)

      // then
      expect(result.success).toBe(true)
      expect(result.configPath).toBe(unifiedPath)
      const savedConfig = parseJsonc<Record<string, unknown>>(readFileSync(unifiedPath, "utf-8"))
      expect(getRecord(savedConfig["[opencode]"]).agents).toMatchObject({
        oracle: { model: "anthropic/legacy" },
      })
      expect(savedConfig.profiles).toBeUndefined()
      expect(existsSync(legacyPath)).toBe(false)
    } finally {
      if (initialHome === undefined) delete process.env.HOME
      else process.env.HOME = initialHome
    }
  })

  it("migrates a legacy config file to the canonical basename before writing", () => {
    // given
    const legacyConfigPath = join(testConfigDir, `${LEGACY_CONFIG_BASENAME}.json`)
    const canonicalConfigPath = testConfigPath
    writeFileSync(legacyConfigPath, JSON.stringify({ disabled_hooks: ["comment-checker"] }, null, 2) + "\n", "utf-8")

    // when
    const result = writeOmoConfig(installConfig)

    // then
    expect(result.success).toBe(true)
    expect(result.configPath).toEndWith(canonicalConfigPath)

    const savedDocument = parseJsonc<Record<string, unknown>>(readFileSync(canonicalConfigPath, "utf-8"))
    expect(getRecord(savedDocument["[opencode]"]).disabled_hooks).toEqual(["comment-checker"])
  })
})
