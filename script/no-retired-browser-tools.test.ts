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

const exclusions = [
  "**/node_modules/**",
  "**/.git/**",
  "**/__pycache__/**",
  "packages/shared-skills/upstreams/**",
  "**/CHANGELOG*",
  "**/THIRD-PARTY-NOTICES.md",
  // TODO-12: remove these exclusions with the OpenCode browser-provider surface.
  "packages/omo-opencode/src/**",
  "packages/skills-loader-core/src/types.ts",
  "packages/skills-loader-core/src/features/opencode-skill-loader/skill-discovery.ts",
  "packages/skills-loader-core/src/features/opencode-skill-loader/skill-content-browser-provider.test.ts",
  "packages/skills-loader-core/src/features/builtin-skills/AGENTS.md",
  "packages/skills-loader-core/src/features/builtin-skills/agent-browser/**",
  "packages/skills-loader-core/src/features/builtin-skills/skills.ts",
  "packages/skills-loader-core/src/features/builtin-skills/skills.test.ts",
  "packages/skills-loader-core/src/features/builtin-skills/skills/**",
  "docs/reference/configuration.md",
] as const

test("ships no retired browser tool instructions outside the pending provider migration", async () => {
  // Given: authored sources and generated payloads, including gitignored shipped skills.
  const cwd = resolve(import.meta.dir, "..")
  const patterns = ["agent-browser", "agent_browser", "npx playwright", "bunx playwright", "playwright install"]

  // When: ripgrep scans the real payload roots, not a mock or a prose snapshot.
  const scan = Bun.spawn([
    "rg", "--no-ignore", "--hidden", "--line-number", "--with-filename", "--only-matching", "--color=never",
    ...patterns.flatMap((pattern) => ["-e", pattern]),
    ...exclusions.flatMap((path) => ["--glob", `!${path}`]),
    ...shippedRoots,
  ], { cwd, stdout: "pipe", stderr: "pipe" })
  const [exitCode, stdout, stderr] = await Promise.all([
    scan.exited,
    new Response(scan.stdout).text(),
    new Response(scan.stderr).text(),
  ])

  // Then: exit 1 means no matches; missing roots or scan errors must not pass.
  expect(stderr).toBe("")
  expect(stdout, `Retired browser tools remain at file:line:\n${stdout}`).toBe("")
  expect(exitCode).toBe(1)
})
