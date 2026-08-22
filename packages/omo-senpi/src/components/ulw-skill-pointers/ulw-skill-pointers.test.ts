/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test"

import { FakeExtensionAPI } from "../../../test-support/fake-extension-api"
import type { ComponentContext, ComponentLogger } from "../../extension/types"
import {
  createUlwSkillPointersComponent,
  matchedUlwSkillNames,
  ULW_LOOP_CUSTOM_TYPE,
  ULW_RESEARCH_CUSTOM_TYPE,
  ULW_SKILL_POINTERS_DISABLED_FLAG,
} from "./index"

type InputDispatchResult = { action: "continue" } | { action: "transform"; text: string }

function createTestContext(pi: FakeExtensionAPI): ComponentContext {
  const logger: ComponentLogger = {
    info() {},
    warn() {},
    error() {},
  }
  return {
    logger,
    config: {
      getFlag(name) {
        return pi.getFlag(name)
      },
    },
  }
}

async function registerUlwSkillPointers(pi: FakeExtensionAPI): Promise<void> {
  await createUlwSkillPointersComponent().register(pi, createTestContext(pi))
}

async function dispatchInput(
  pi: FakeExtensionAPI,
  text: unknown,
  source: unknown = "interactive",
  streamingBehavior?: unknown,
): Promise<InputDispatchResult> {
  const [result] = await pi.dispatch("input", {
    type: "input",
    text,
    source,
    ...(streamingBehavior === undefined ? {} : { streamingBehavior }),
  })
  return result as InputDispatchResult
}

function expectSinglePointerInjection(pi: FakeExtensionAPI, result: unknown, customType: string, skillName: string): void {
  expect(result).toEqual({ action: "continue" })
  expect(pi.messages).toHaveLength(1)
  const [call] = pi.messages
  expect(call?.message["customType"]).toBe(customType)
  expect(call?.message["display"]).toBe(false)
  const content = call?.message["content"]
  if (typeof content !== "string") {
    throw new Error("expected a string skill-pointer message")
  }
  expect(content).toContain(`${skillName}/SKILL.md`)
  expect(content).toContain("read tool")
}

function expectNoInjection(pi: FakeExtensionAPI, result: unknown): void {
  expect(result).toEqual({ action: "continue" })
  expect(pi.messages).toHaveLength(0)
}

describe("omo-senpi ulw-skill-pointers component", () => {
  describe("#given the keyword detector", () => {
    it("#when given ulw-loop trigger spellings #then ulw-loop matches", () => {
      const triggers = [
        "ulw loop",
        "ulw-loop",
        "ulwloop",
        "ULW LOOP",
        "Ulw-Loop",
        "ulw  loop",
        "mass ulw loop",
        "go ulw loop",
        "make pr work until gets merged go ulw loop",
      ] as const
      for (const text of triggers) {
        expect({ text, matched: matchedUlwSkillNames(text) }).toEqual({ text, matched: ["ulw-loop"] })
      }
    })

    it("#when given ulw-research trigger spellings #then ulw-research matches", () => {
      const triggers = [
        "ulw research",
        "ulw-research",
        "ulwresearch",
        "ULW RESEARCH",
        "Ulw-Research",
        "mass ulw research",
        "run ulw research on this topic",
      ] as const
      for (const text of triggers) {
        expect({ text, matched: matchedUlwSkillNames(text) }).toEqual({ text, matched: ["ulw-research"] })
      }
    })

    it("#when both skills are mentioned #then both match in stable order", () => {
      expect(matchedUlwSkillNames("ulw loop then ulw research")).toEqual(["ulw-loop", "ulw-research"])
      expect(matchedUlwSkillNames("ulw research first, ulw loop second")).toEqual(["ulw-loop", "ulw-research"])
    })

    it("#when given near-miss spellings #then nothing matches", () => {
      const misses = [
        "ulw",
        "ultrawork",
        "mass ulw",
        "ulw mass",
        "mulw",
        "meth",
        "ulw-looper",
        "ulwloops go brr",
        "loop ulw",
        "research ulw",
        "ulw plan",
        "just loop it",
        "research this",
        "kulw loop of yarn",
      ] as const
      for (const text of misses) {
        expect({ text, matched: matchedUlwSkillNames(text) }).toEqual({ text, matched: [] })
      }
    })
  })

  describe("#given a matching interactive prompt", () => {
    it("#when mass ulw loop is dispatched #then one hidden ulw-loop pointer is injected and the text is untouched", async () => {
      // given
      const pi = new FakeExtensionAPI()
      await registerUlwSkillPointers(pi)

      // when
      const result = await dispatchInput(pi, "mass ulw loop ship the docs refresh")

      // then
      expectSinglePointerInjection(pi, result, ULW_LOOP_CUSTOM_TYPE, "ulw-loop")
    })

    it("#when mass ulw research is dispatched #then one hidden ulw-research pointer is injected", async () => {
      // given
      const pi = new FakeExtensionAPI()
      await registerUlwSkillPointers(pi)

      // when
      const result = await dispatchInput(pi, "mass ulw research the gateway options")

      // then
      expectSinglePointerInjection(pi, result, ULW_RESEARCH_CUSTOM_TYPE, "ulw-research")
    })

    it("#when both skills are mentioned #then one pointer per skill is injected", async () => {
      // given
      const pi = new FakeExtensionAPI()
      await registerUlwSkillPointers(pi)

      // when
      const result = await dispatchInput(pi, "ulw loop the fixes, then ulw research the alternatives")

      // then
      expect(result).toEqual({ action: "continue" })
      expect(pi.messages).toHaveLength(2)
      expect(pi.messages.map((call) => call.message["customType"])).toEqual([ULW_LOOP_CUSTOM_TYPE, ULW_RESEARCH_CUSTOM_TYPE])
      for (const call of pi.messages) {
        expect(call.message["display"]).toBe(false)
      }
    })
  })

  describe("#given a queued prompt", () => {
    it("#when streamingBehavior is set #then the pointer rides inside the same message", async () => {
      // given
      const pi = new FakeExtensionAPI()
      await registerUlwSkillPointers(pi)

      // when
      const result = await dispatchInput(pi, "mass ulw loop queued work", "interactive", "steer")

      // then
      expect(result.action).toBe("transform")
      if (result.action !== "transform") throw new Error("expected transform")
      expect(result.text).toMatch(/^mass ulw loop queued work\n/)
      expect(result.text).toContain("ulw-loop/SKILL.md")
      expect(pi.messages).toHaveLength(0)
    })

    it("#when both skills are mentioned on the queued path #then both pointers ride inside the one message", async () => {
      // given
      const pi = new FakeExtensionAPI()
      await registerUlwSkillPointers(pi)

      // when
      const result = await dispatchInput(pi, "ulw loop then ulw research", "interactive", "followUp")

      // then
      expect(result.action).toBe("transform")
      if (result.action !== "transform") throw new Error("expected transform")
      expect(result.text).toContain("ulw-loop/SKILL.md")
      expect(result.text).toContain("ulw-research/SKILL.md")
      expect(pi.messages).toHaveLength(0)
    })
  })

  describe("#given suppression conditions", () => {
    it("#when the source is extension #then nothing is injected", async () => {
      // given
      const pi = new FakeExtensionAPI()
      await registerUlwSkillPointers(pi)

      // when
      const result = await dispatchInput(pi, "mass ulw loop from extension", "extension")

      // then
      expectNoInjection(pi, result)
    })

    it("#when the prompt is the raw /skill:ulw-loop command #then no ulw-loop pointer is injected", async () => {
      // given
      const pi = new FakeExtensionAPI()
      await registerUlwSkillPointers(pi)

      // when
      const result = await dispatchInput(pi, "/skill:ulw-loop run the loop")

      // then
      expectNoInjection(pi, result)
    })

    it("#when /skill:ulw-loop args mention ulw research #then only the research pointer is injected", async () => {
      // given
      const pi = new FakeExtensionAPI()
      await registerUlwSkillPointers(pi)

      // when
      const result = await dispatchInput(pi, "/skill:ulw-loop then ulw research the fallout")

      // then
      expectSinglePointerInjection(pi, result, ULW_RESEARCH_CUSTOM_TYPE, "ulw-research")
    })

    it("#when the prompt carries an expanded ulw-loop skill block #then no ulw-loop pointer is injected", async () => {
      // given
      const pi = new FakeExtensionAPI()
      await registerUlwSkillPointers(pi)

      // when
      const result = await dispatchInput(
        pi,
        '<skill name="ulw-loop" path="skills/ulw-loop/SKILL.md">skill body mentioning ulw loop</skill> now run it',
      )

      // then
      expectNoInjection(pi, result)
    })

    it("#when the component flag is disabled #then nothing is injected", async () => {
      // given
      const pi = new FakeExtensionAPI()
      pi.setFlag(ULW_SKILL_POINTERS_DISABLED_FLAG, true)
      await registerUlwSkillPointers(pi)

      // when
      const result = await dispatchInput(pi, "mass ulw loop ship it")

      // then
      expectNoInjection(pi, result)
    })

    it("#when the text has no keyword #then nothing is injected", async () => {
      // given
      const pi = new FakeExtensionAPI()
      await registerUlwSkillPointers(pi)

      // when
      const result = await dispatchInput(pi, "ordinary follow-up")

      // then
      expectNoInjection(pi, result)
    })
  })
})
