import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const repoRoot = join(import.meta.dir, "..", "..", "..")

// The shipped prompt surfaces are split between authored sources and generated artifacts:
// plugin/skills/** is deleted and rebuilt by sync-skills.mjs, and
// src/components/ultrawork/generated-directive.ts is rebuilt by embed-directive.mjs.
// Every contract below is asserted on BOTH sides, so a clause that only exists in a
// generated file (and would be wiped on the next sync) cannot pass.
const ULTRAWORK_SOURCE = "packages/omo-senpi/skills/ultrawork/SKILL.md"
const GENERATED_DIRECTIVE = "packages/omo-senpi/src/components/ultrawork/generated-directive.ts"
const ULW_LOOP_SOURCE = "packages/omo-codex/plugin/components/ulw-loop/skills/ulw-loop/SKILL.md"
const ULW_LOOP_GENERATED = "packages/omo-senpi/plugin/skills/ulw-loop/SKILL.md"
const SYNC_SCRIPT = "packages/omo-senpi/plugin/scripts/sync-skills.mjs"
const ULW_PLAN_GENERATED = "packages/omo-senpi/plugin/skills/ulw-plan/SKILL.md"

function read(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf8")
}

describe("ulw reviewer gating and delegation guidance", () => {
  describe("#given the ultrawork verification gate", () => {
    test("#when the trigger list is read #then a produced plan gates the reviewer instead of tier alone", () => {
      // given / when
      const content = read(ULTRAWORK_SOURCE)
      const gate = content.slice(content.indexOf("# Verification gate"), content.indexOf("# Commits"))

      // then
      expect(gate).toContain("ulw-plan")
      expect(gate).toMatch(/only when .*plan|plan .*produced|produced a plan/i)
      expect(gate).toMatch(/momus/)
    })

    test("#when a bare ulw run is described #then the gate names self-review as the no-plan path", () => {
      // given / when
      const content = read(ULTRAWORK_SOURCE)
      const gate = content.slice(content.indexOf("# Verification gate"), content.indexOf("# Commits"))

      // then
      expect(gate).toMatch(/no plan|without a plan|bare `?ulw`?/i)
      expect(gate).toContain("self-review")
    })

    test("#when the generated directive is read #then it carries the same plan-gated reviewer rule", () => {
      // given / when
      const directive = read(GENERATED_DIRECTIVE)

      // then
      expect(directive).toContain("ulw-plan")
      expect(directive).toMatch(/momus/)
    })
  })

  describe("#given the parallel delegation guidance", () => {
    test("#when the delegation rule is read #then fan-out is the default rather than a permission", () => {
      // given / when
      const content = read(ULTRAWORK_SOURCE)

      // then
      expect(content).toMatch(/DEFAULT to fan-out|fan out by default|default is to fan out/i)
      expect(content).toContain("run_in_background")
    })

    test("#when model priors are addressed #then under-delegating models are told to push harder", () => {
      // given / when
      const content = read(ULTRAWORK_SOURCE)

      // then
      expect(content).toMatch(/under-delegat/i)
      expect(content).toMatch(/prior/i)
    })

    test("#when the generated directive is read #then the delegation default survives generation", () => {
      // given / when
      const directive = read(GENERATED_DIRECTIVE)

      // then
      expect(directive).toMatch(/under-delegat/i)
      expect(directive).toMatch(/DEFAULT to fan-out|fan out by default|default is to fan out/i)
    })
  })

  describe("#given the ulw-loop team-mode decision guide", () => {
    test("#when the authored source is read #then team mode is decided by overlap plus concurrency payoff", () => {
      // given / when
      const content = read(ULW_LOOP_SOURCE)

      // then
      expect(content).toContain("team_create")
      expect(content).toMatch(/overlap/i)
      expect(content).toMatch(/concurren/i)
    })

    test("#when the authored source is read #then it names worktree isolation and per-unit merge", () => {
      // given / when
      const content = read(ULW_LOOP_SOURCE)

      // then
      expect(content).toMatch(/worktree/i)
      expect(content).toMatch(/merge/i)
    })

    test("#when the synced skill is read #then the decision guide survives the sync pipeline", () => {
      // given / when
      const generated = read(ULW_LOOP_GENERATED)

      // then
      expect(generated).toMatch(/overlap/i)
      expect(generated).toMatch(/worktree/i)
      expect(generated).toContain("team_create")
    })
  })

  describe("#given the senpi ulw-plan overlay", () => {
    test("#when the overlay constant is read #then it ties the momus review to the produced plan file", () => {
      // given / when
      const sync = read(SYNC_SCRIPT)

      // then
      expect(sync).toMatch(/momus/)
      expect(sync).toMatch(/plan file|produced plan|complete plan/i)
    })

    test("#when the generated ulw-plan skill is read #then the review override still ships", () => {
      // given / when
      const generated = read(ULW_PLAN_GENERATED)

      // then
      expect(generated).toContain("## Senpi Review Override (authoritative)")
      expect(generated).toContain("momus")
    })
  })
})
