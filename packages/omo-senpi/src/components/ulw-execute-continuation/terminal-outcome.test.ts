import { afterEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { FakeExtensionAPI } from "../../../test-support/fake-extension-api"
import { IdleInjectionCoordinator } from "../../extension/idle-injection-coordinator"
import { createUlwLoopComponent } from "../ulw-loop"
import { activeStatus, createLogger } from "../ulw-loop/ulw-loop.test-support"
import { createUlwExecuteContinuationComponent } from "./index"

// https://github.com/code-yeongyu/senpi/issues/1520
const CODEX_ERROR = "Codex error: This request was blocked by our safety systems. Reason: Potentially unintended activity."
const clean = { type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }], willRetry: false }
const errorMessage = { role: "assistant", stopReason: "error", errorMessage: CODEX_ERROR, content: [] }
const blockedOutcomes = [
  { name: "terminal Codex safety error", event: { ...clean, messages: [errorMessage] } },
  { name: "ordinary provider failure", event: { ...clean, messages: [{ ...errorMessage, errorMessage: "Connection failed" }] } },
  { name: "aborted run", event: { ...clean, aborted: true } },
  { name: "aborted assistant", event: { ...clean, messages: [{ role: "assistant", stopReason: "aborted" }] } },
  { name: "host-owned retry", event: { ...clean, willRetry: true } },
  { name: "empty tool-use refusal", event: { ...clean, messages: [{ role: "assistant", stopReason: "toolUse", content: [], stopDetails: { type: "refusal" } }] } },
  { name: "sensitive stop", event: { ...clean, messages: [{ role: "assistant", stopReason: "toolUse", content: [], stopDetails: { type: "sensitive" } }] } },
  { name: "normalized empty-tool-use refusal", event: { ...clean, messages: [{ role: "assistant", stopReason: "stop", content: [], stopDetails: { type: "refusal" } }] } },
  { name: "normalized sensitive stop", event: { ...clean, messages: [{ role: "assistant", stopReason: "stop", content: [], stopDetails: { type: "sensitive" } }] } },
  { name: "missing outcome", event: { type: "agent_end" } },
  { name: "empty outcome", event: { ...clean, messages: [] } },
  { name: "missing stop reason", event: { ...clean, messages: [{ role: "assistant" }] } },
  { name: "error behind custom tail", event: { ...clean, messages: [errorMessage, { role: "custom", content: "notice" }] } },
]
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function setup(component: "loop" | "boulder", coordinated: boolean) {
  const root = mkdtempSync(join(tmpdir(), "omo-terminal-outcome-"))
  roots.push(root)
  const pi = new FakeExtensionAPI()
  const scheduled: Array<() => void> = []
  const coordinator = new IdleInjectionCoordinator(
    (message, options) => pi.sendMessage(message, { triggerTurn: true, deliverAs: options.deliverAs }),
    { scheduleFlush: (flush) => scheduled.push(flush) },
  )
  let status = activeStatus()
  const advance = (revision: number) => {
    status = activeStatus(`G${revision}`)
    if (component === "boulder") {
      writeFileSync(join(root, ".omo", "boulder.json"), JSON.stringify({
        schema_version: 2, active_work_id: "w1", works: { w1: {
          work_id: "w1", active_plan: ".omo/plans/task.md", plan_name: "task",
          session_ids: ["senpi:qa-s1"], status: "active", started_at: "2026-09-09T00:00:00Z",
          updated_at: `2026-09-09T00:00:${String(revision).padStart(2, "0")}Z`,
        } },
      }))
    }
  }
  if (component === "boulder") {
    mkdirSync(join(root, ".omo", "plans"), { recursive: true })
    writeFileSync(join(root, ".omo", "plans", "task.md"), "## TODOs\n- [ ] 1. Task one\n")
  }
  advance(0)
  const hook = component === "loop" ? createUlwLoopComponent({
    resolveOmoBin: () => "/fixture/toolkit",
    planExists: () => true,
    runCommand: async () => ({ code: 0, stdout: status }),
  }) : createUlwExecuteContinuationComponent()
  await hook.register(pi, {
    logger: createLogger(), config: { getFlag: () => false },
    ...(coordinated ? { idleCoordinator: coordinator } : {}),
  })
  return {
    pi, coordinator, scheduled, advance,
    async end(event: unknown) {
      await pi.dispatch("agent_end", event, { cwd: root, sessionManager: { getSessionId: () => "qa-s1" } })
      for (const flush of scheduled.splice(0)) flush()
    },
  }
}

for (const component of ["loop", "boulder"] as const) {
  for (const coordinated of [false, true]) {
    describe(`${component} terminal outcome via ${coordinated ? "real coordinator" : "direct delivery"}`, () => {
      for (const { name, event } of blockedOutcomes) {
        it(`#given active plan and ${name} #when agent_end fires #then no automatic send or budget consumption`, async () => {
          const scenario = await setup(component, coordinated)
          // given nine failed edges would exhaust the continuation cap if counted
          for (let i = 0; i < 9; i++) await scenario.end(event)
          expect(scenario.pi.messages).toEqual([])
          expect(scenario.pi.userMessages).toEqual([])
          expect(scenario.coordinator.pendingCount()).toBe(0)
          expect(scenario.scheduled).toEqual([])
          // when the same active status ends cleanly, its signature and all eight slots remain available
          for (let i = 0; i < 9; i++) {
            scenario.advance(i)
            await scenario.end(clean)
          }
          // then the normal cap still applies
          expect(scenario.pi.messages).toHaveLength(8)
        })
      }

      it("#given explanatory assistant text #when the run stops cleanly #then it still continues", async () => {
        const scenario = await setup(component, coordinated)
        await scenario.end({ ...clean, messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: CODEX_ERROR }] }] })
        expect(scenario.pi.messages).toHaveLength(1)
      })

      it("#given an earlier failed attempt #when the last assistant succeeds #then it still continues", async () => {
        const scenario = await setup(component, coordinated)
        await scenario.end({ ...clean, messages: [errorMessage, ...clean.messages, { role: "custom", content: "notice" }] })
        expect(scenario.pi.messages).toHaveLength(1)
      })

      it("#given an already continued signature #when a failure intervenes #then it does not reset dedupe", async () => {
        const scenario = await setup(component, coordinated)
        await scenario.end(clean)
        await scenario.end({ ...clean, messages: [errorMessage] })
        await scenario.end(clean)
        expect(scenario.pi.messages).toHaveLength(1)
      })
    })
  }
}
