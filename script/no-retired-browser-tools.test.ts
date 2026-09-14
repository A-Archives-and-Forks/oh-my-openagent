import { expect, test } from "bun:test"
import { resolve } from "node:path"

const shippedRoots = [
  "packages/shared-skills/skills",
  "packages/omo-senpi/skills",
  "packages/omo-senpi/plugin/skills",
  "packages/omo-codex/plugin/skills",
  "packages/omo-codex/plugin/components",
  "packages/prompts-core/prompts",
  "docs",
  "packages/omo-opencode/src",
  "packages/skills-loader-core/src",
] as const

// TODO-12: only files implementing or testing the legacy browser-provider contract.
const providerFiles = [
  "packages/omo-opencode/src/agents/utils.test.ts",
  "packages/omo-opencode/src/config/schema.test.ts",
  "packages/omo-opencode/src/config/schema/agent-names.ts",
  "packages/omo-opencode/src/config/schema/browser-automation.ts",
  "packages/omo-opencode/src/features/opencode-skill-loader/skill-content.test.ts",
  "packages/omo-opencode/src/plugin/skill-context.test.ts",
  "packages/omo-opencode/src/plugin/skill-context.ts",
  "packages/omo-opencode/src/tools/delegate-task/tools.test.ts",
  "packages/omo-opencode/src/tools/skill/zauc-mocks-skill-tools/browser-provider.test.ts",
  "packages/skills-loader-core/src/types.ts",
  "packages/skills-loader-core/src/features/opencode-skill-loader/skill-discovery.ts",
  "packages/skills-loader-core/src/features/opencode-skill-loader/skill-content-browser-provider.test.ts",
  "packages/skills-loader-core/src/features/builtin-skills/agent-browser/SKILL.md",
  "packages/skills-loader-core/src/features/builtin-skills/skills.ts",
  "packages/skills-loader-core/src/features/builtin-skills/skills.test.ts",
  "packages/skills-loader-core/src/features/builtin-skills/skills/agent-browser-skill.ts",
  "packages/skills-loader-core/src/features/builtin-skills/skills/agent-browser-template.test.ts",
  "packages/skills-loader-core/src/features/builtin-skills/skills/agent-browser-template.ts",
  "packages/skills-loader-core/src/features/builtin-skills/skills/playwright.test.ts",
  "packages/skills-loader-core/src/features/builtin-skills/skills/playwright.ts",
] as const

test("ships no retired browser tool instructions outside the pending provider migration", async () => {
  // Given: tracked authored sources and checked-in payloads; ignored outputs are rebuilt, not inputs.
  const cwd = resolve(import.meta.dir, "..")
  const patterns = ["agent-browser", "agent_browser", "npx playwright", "bunx playwright", "playwright install"]

  // When: Git scans tracked working-tree contents, including uncommitted edits but not stale builds.
  const scan = Bun.spawn([
    "git", "grep", "--full-name", "--line-number", "--no-color", "--fixed-strings",
    ...patterns.flatMap((pattern) => ["-e", pattern]),
    "--", ...shippedRoots,
    ...providerFiles.map((path) => `:(exclude,literal)${path}`),
  ], { cwd, stdout: "pipe", stderr: "pipe" })
  const [exitCode, stdout, stderr] = await Promise.all([
    scan.exited,
    new Response(scan.stdout).text(),
    new Response(scan.stderr).text(),
  ])

  // TODO-12: exempt only the configuration table row keyed by this provider, not the document.
  const lines = stdout.trimEnd().split("\n").filter(Boolean)
  const providerRow = /^docs\/reference\/configuration\.md:\d+:\| `agent-browser`\s*\|/
  const violations = lines.filter((line) => !providerRow.test(line))

  // Then: only the reserved row may match; Git errors and additional rows still fail.
  expect(stderr).toBe("")
  expect([0, 1]).toContain(exitCode)
  expect(lines.length - violations.length).toBeLessThanOrEqual(1)
  expect(violations, `Retired browser tools remain at file:line:\n${violations.join("\n")}`).toEqual([])
})
