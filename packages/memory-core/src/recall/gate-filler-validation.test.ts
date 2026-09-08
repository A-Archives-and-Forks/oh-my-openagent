import { afterEach, describe, expect, test } from "bun:test"
import { realpathSync } from "node:fs"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isFillerHint, isValidHint, PendingNudges, validateNudges } from "./gate"

// The observed defect: a judge decided NOT to nudge, then called nudge(path, "placeholder") anyway.
const FILLER_HINTS = [
  "placeholder",
  "Placeholder.",
  "This is a placeholder",
  "placeholder hint",
  "<hint>",
  "{hint}",
  "[one factual sentence]",
  "TODO",
  "N/A",
  "lorem ipsum dolor sit amet",
  "insert memory fact here",
  "Hint goes here.",
  "...",
  "   ",
]
const FACTUAL_HINTS = [
  "Use it.",
  "alpha",
  "빌드는 bun-only다",
  "For herdr coordination, use `herdr pane run <pane_id>`.",
  "Tests use a placeholder key SK-SENTINEL that wins auth resolution and causes 401.",
  "eval output is sometimes bare {text}; normalize both shapes.",
  "The test suite runs on gorky.",
]
const path = "reference/a.md"
const options = { candidates: new Set([path]), surfaced: new Set<string>(), maxItems: 1 }
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("filler hint validation", () => {
  for (const hint of FILLER_HINTS) {
    test(`#given the filler hint ${JSON.stringify(hint)} #when validated #then it is rejected without spending the cap`, () => {
      expect(isFillerHint(hint)).toBe(true)
      expect(isValidHint(hint)).toBe(false)
      expect(validateNudges([{ path, hint }], options)).toEqual([])
      const corrected = { path, hint: FACTUAL_HINTS[0]! }
      expect(validateNudges([{ path, hint }, corrected], options)).toEqual([corrected])
    })
  }

  test("#given a pending payload holding a filler hint #when taken #then the whole payload is rejected and deleted", async () => {
    const dir = realpathSync.native(await mkdtemp(join(tmpdir(), "recall-filler-")))
    tempDirs.push(dir)
    const pending = new PendingNudges(dir)
    await pending.write("session-1", [
      { path: "notes/valid.md", hint: FACTUAL_HINTS[0]! },
      { path, hint: "placeholder" },
    ], { epoch: 0 })

    expect(await pending.take("session-1", { currentEpoch: 0 })).toEqual([])
    expect(await readdir(dir)).toEqual([])
  })

  for (const hint of FACTUAL_HINTS) {
    test(`#given the factual hint ${JSON.stringify(hint)} #when validated #then it survives unchanged`, () => {
      expect(isFillerHint(hint)).toBe(false)
      expect(isValidHint(hint)).toBe(true)
      expect(validateNudges([{ path, hint }], options)).toEqual([{ path, hint }])
    })
  }
})
