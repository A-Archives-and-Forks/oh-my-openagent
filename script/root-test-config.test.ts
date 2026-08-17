import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"

const baseConfigPath = new URL("../bunfig.toml", import.meta.url)
const rootConfigPath = new URL("../bunfig.root.toml", import.meta.url)
const workflowPath = new URL("../.github/workflows/ci.yml", import.meta.url)

function quotedPatterns(config: string): readonly string[] {
  return [...config.matchAll(/"([^"]+\/\*\*)"/g)].map((match) => match[1] ?? "")
}

describe("root test Bun config", () => {
  test("#given package-specific CI jobs #when the root suite config is inspected #then every base ignore remains active", () => {
    expect(existsSync(rootConfigPath)).toBe(true)
    if (!existsSync(rootConfigPath)) return

    const basePatterns = quotedPatterns(readFileSync(baseConfigPath, "utf8"))
    const rootPatterns = quotedPatterns(readFileSync(rootConfigPath, "utf8"))

    for (const pattern of basePatterns) {
      expect(rootPatterns).toContain(pattern)
    }
  })

  test("#given the dedicated Senpi compatibility job #when root tests run #then omo-senpi is excluded", () => {
    expect(existsSync(rootConfigPath)).toBe(true)
    if (!existsSync(rootConfigPath)) return

    expect(quotedPatterns(readFileSync(rootConfigPath, "utf8"))).toContain("packages/omo-senpi/**")
  })

  test("#given the dedicated root config #when CI invokes Bun #then the config is passed after the test command", () => {
    expect(readFileSync(workflowPath, "utf8")).toContain("run: bun test -c bunfig.root.toml")
  })
})
