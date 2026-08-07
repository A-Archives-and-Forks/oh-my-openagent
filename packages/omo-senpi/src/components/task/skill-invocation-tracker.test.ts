import { describe, expect, test } from "bun:test"

import { FakeExtensionAPI } from "../../../test-support/fake-extension-api"
import { createSkillInvocationTracker } from "./skill-invocation-tracker"

const CTX_A = { sessionManager: { getSessionId: () => "sess-a" } }
const CTX_B = { sessionManager: { getSessionId: () => "sess-b" } }

function readResult(path: string, isError = false) {
  return { type: "tool_result", toolCallId: "c1", toolName: "read", input: { path }, content: [], isError }
}

describe("createSkillInvocationTracker", () => {
  test("#given a read of an ulw-plan SKILL.md #when the tool result arrives #then the session has invoked ulw-plan", async () => {
    // given
    const pi = new FakeExtensionAPI()
    const tracker = createSkillInvocationTracker(pi)

    // when
    await pi.dispatch("tool_result", readResult("/repo/packages/omo-senpi/plugin/skills/ulw-plan/SKILL.md"), CTX_A)

    // then
    expect(tracker.stateFor("sess-a").hasInvoked("ulw-plan")).toBe(true)
    expect(tracker.stateFor("sess-a").hasInvoked("start-work")).toBe(false)
  })

  test("#given a read of a start-work SKILL.md #when the tool result arrives #then the session has invoked start-work", async () => {
    // given
    const pi = new FakeExtensionAPI()
    const tracker = createSkillInvocationTracker(pi)

    // when
    await pi.dispatch("tool_result", readResult("/home/u/.senpi/agent/skills/start-work/SKILL.md"), CTX_A)

    // then
    expect(tracker.stateFor("sess-a").hasInvoked("start-work")).toBe(true)
  })

  test("#given a read of a non-skill file #when the tool result arrives #then nothing is recorded", async () => {
    // given
    const pi = new FakeExtensionAPI()
    const tracker = createSkillInvocationTracker(pi)

    // when
    await pi.dispatch("tool_result", readResult("/repo/src/skills-notes.md"), CTX_A)
    await pi.dispatch("tool_result", readResult("/repo/src/SKILL.md"), CTX_A)

    // then
    expect(tracker.stateFor("sess-a").hasInvoked("ulw-plan")).toBe(false)
  })

  test("#given a failed read of a skill file #when the tool result arrives #then nothing is recorded", async () => {
    // given
    const pi = new FakeExtensionAPI()
    const tracker = createSkillInvocationTracker(pi)

    // when
    await pi.dispatch("tool_result", readResult("/repo/plugin/skills/ulw-plan/SKILL.md", true), CTX_A)

    // then
    expect(tracker.stateFor("sess-a").hasInvoked("ulw-plan")).toBe(false)
  })

  test("#given a non-read tool result naming a skill path #when it arrives #then nothing is recorded", async () => {
    // given
    const pi = new FakeExtensionAPI()
    const tracker = createSkillInvocationTracker(pi)

    // when
    await pi.dispatch(
      "tool_result",
      { type: "tool_result", toolCallId: "c2", toolName: "grep", input: { path: "/repo/plugin/skills/ulw-plan/SKILL.md" }, content: [], isError: false },
      CTX_A,
    )

    // then
    expect(tracker.stateFor("sess-a").hasInvoked("ulw-plan")).toBe(false)
  })

  test("#given a slash skill input #when the input arrives #then the named skill is recorded", async () => {
    // given
    const pi = new FakeExtensionAPI()
    const tracker = createSkillInvocationTracker(pi)

    // when
    await pi.dispatch("input", { text: "/skill:ulw-plan plan the auth refactor" }, CTX_A)

    // then
    expect(tracker.stateFor("sess-a").hasInvoked("ulw-plan")).toBe(true)
  })

  test("#given a plain input mentioning a skill #when the input arrives #then nothing is recorded", async () => {
    // given
    const pi = new FakeExtensionAPI()
    const tracker = createSkillInvocationTracker(pi)

    // when
    await pi.dispatch("input", { text: "should we use ulw-plan for this?" }, CTX_A)

    // then
    expect(tracker.stateFor("sess-a").hasInvoked("ulw-plan")).toBe(false)
  })

  test("#given an invocation in session A #when session B is queried #then it stays locked", async () => {
    // given
    const pi = new FakeExtensionAPI()
    const tracker = createSkillInvocationTracker(pi)

    // when
    await pi.dispatch("tool_result", readResult("/repo/plugin/skills/ulw-plan/SKILL.md"), CTX_A)

    // then
    expect(tracker.stateFor("sess-a").hasInvoked("ulw-plan")).toBe(true)
    expect(tracker.stateFor("sess-b").hasInvoked("ulw-plan")).toBe(false)
  })

  test("#given an invocation followed by session shutdown #when the session is queried #then the state is dropped", async () => {
    // given
    const pi = new FakeExtensionAPI()
    const tracker = createSkillInvocationTracker(pi)
    await pi.dispatch("tool_result", readResult("/repo/plugin/skills/ulw-plan/SKILL.md"), CTX_A)

    // when
    await pi.dispatch("session_shutdown", {}, CTX_A)

    // then
    expect(tracker.stateFor("sess-a").hasInvoked("ulw-plan")).toBe(false)
  })

  test("#given a windows-style skill path #when the tool result arrives #then the skill is recorded", async () => {
    // given
    const pi = new FakeExtensionAPI()
    const tracker = createSkillInvocationTracker(pi)

    // when
    await pi.dispatch("tool_result", readResult("C:\\repo\\plugin\\skills\\ulw-plan\\SKILL.md"), CTX_A)

    // then
    expect(tracker.stateFor("sess-a").hasInvoked("ulw-plan")).toBe(true)
  })
})

describe("createSkillInvocationTracker - user-request channel", () => {
  test("#given a plain user input asking for ulw plan #when it arrives #then it is recorded as a user request but not an invocation", async () => {
    // given
    const pi = new FakeExtensionAPI()
    const tracker = createSkillInvocationTracker(pi)

    // when
    await pi.dispatch("input", { text: "ulw plan \uc73c\ub85c \uc791\uc5c5\uacc4\ud68d\uc11c \ub9cc\ub4e4\uc5b4\uc918" }, CTX_A)

    // then
    expect(tracker.stateFor("sess-a").hasUserRequested("ulw-plan")).toBe(true)
    expect(tracker.stateFor("sess-a").hasInvoked("ulw-plan")).toBe(false)
  })

  test("#given a slash skill input #when it arrives #then it counts as both an invocation and a user request", async () => {
    // given
    const pi = new FakeExtensionAPI()
    const tracker = createSkillInvocationTracker(pi)

    // when
    await pi.dispatch("input", { text: "/skill:ulw-plan plan the auth refactor" }, CTX_A)

    // then
    expect(tracker.stateFor("sess-a").hasInvoked("ulw-plan")).toBe(true)
    expect(tracker.stateFor("sess-a").hasUserRequested("ulw-plan")).toBe(true)
  })

  test("#given an ulw-plan mention only inside an ultrawork-mode block #when the input arrives #then no user request is recorded", async () => {
    // given
    const pi = new FakeExtensionAPI()
    const tracker = createSkillInvocationTracker(pi)

    // when
    await pi.dispatch(
      "input",
      { text: "fix the login bug\n<ultrawork-mode>\nTrigger ONLY when a ulw-plan run produced a plan file.\n</ultrawork-mode>" },
      CTX_A,
    )

    // then
    expect(tracker.stateFor("sess-a").hasUserRequested("ulw-plan")).toBe(false)
  })

  test("#given an ulw-plan mention only inside a system-reminder block #when the input arrives #then no user request is recorded", async () => {
    // given
    const pi = new FakeExtensionAPI()
    const tracker = createSkillInvocationTracker(pi)

    // when
    await pi.dispatch(
      "input",
      { text: "<system-reminder>senpi ulw-plan overrides pending</system-reminder>\ncontinue the migration" },
      CTX_A,
    )

    // then
    expect(tracker.stateFor("sess-a").hasUserRequested("ulw-plan")).toBe(false)
  })
})

describe("createSkillInvocationTracker - plan-artifact channel", () => {
  function toolResult(toolName: string, input: Record<string, unknown>, isError = false) {
    return { type: "tool_result", toolCallId: "c9", toolName, input, content: [], isError }
  }

  test("#given a write into a worktree .omo/plans file #when the tool result arrives #then the session has a plan artifact", async () => {
    // given
    const pi = new FakeExtensionAPI()
    const tracker = createSkillInvocationTracker(pi)

    // when
    await pi.dispatch("tool_result", toolResult("write", { path: "/repo/.local-ignore/worktrees/wt1/.omo/plans/feature.md" }), CTX_A)

    // then
    expect(tracker.stateFor("sess-a").hasPlanArtifact()).toBe(true)
    expect(tracker.stateFor("sess-b").hasPlanArtifact()).toBe(false)
  })

  test("#given an edit of a relative .omo/plans path #when the tool result arrives #then the artifact is recorded", async () => {
    // given
    const pi = new FakeExtensionAPI()
    const tracker = createSkillInvocationTracker(pi)

    // when
    await pi.dispatch("tool_result", toolResult("edit", { path: ".omo/plans/refactor.md" }), CTX_A)

    // then
    expect(tracker.stateFor("sess-a").hasPlanArtifact()).toBe(true)
  })

  test("#given a read of a plan file written by a planning child #when the tool result arrives #then the artifact is recorded", async () => {
    // given
    const pi = new FakeExtensionAPI()
    const tracker = createSkillInvocationTracker(pi)

    // when
    await pi.dispatch("tool_result", toolResult("read", { path: "/other/checkout/.omo/plans/child-authored.md" }), CTX_A)

    // then
    expect(tracker.stateFor("sess-a").hasPlanArtifact()).toBe(true)
  })

  test("#given an apply_patch whose patch body touches .omo/plans #when the tool result arrives #then the artifact is recorded", async () => {
    // given
    const pi = new FakeExtensionAPI()
    const tracker = createSkillInvocationTracker(pi)

    // when
    await pi.dispatch(
      "tool_result",
      toolResult("apply_patch", { input: "*** Begin Patch\n*** Add File: .omo/plans/release.md\n+# Plan\n*** End Patch" }),
      CTX_A,
    )

    // then
    expect(tracker.stateFor("sess-a").hasPlanArtifact()).toBe(true)
  })

  test("#given non-plan writes and failed plan writes #when the tool results arrive #then no artifact is recorded", async () => {
    // given
    const pi = new FakeExtensionAPI()
    const tracker = createSkillInvocationTracker(pi)

    // when
    await pi.dispatch("tool_result", toolResult("write", { path: "/repo/docs/plans.md" }), CTX_A)
    await pi.dispatch("tool_result", toolResult("write", { path: ".omo/plans/broken.md" }, true), CTX_A)
    await pi.dispatch("tool_result", toolResult("grep", { path: ".omo/plans/scan.md" }), CTX_A)

    // then
    expect(tracker.stateFor("sess-a").hasPlanArtifact()).toBe(false)
  })

  test("#given a recorded request and artifact followed by session shutdown #when queried #then all state is dropped", async () => {
    // given
    const pi = new FakeExtensionAPI()
    const tracker = createSkillInvocationTracker(pi)
    await pi.dispatch("input", { text: "ulw plan please" }, CTX_A)
    await pi.dispatch("tool_result", toolResult("write", { path: ".omo/plans/x.md" }), CTX_A)

    // when
    await pi.dispatch("session_shutdown", {}, CTX_A)

    // then
    expect(tracker.stateFor("sess-a").hasUserRequested("ulw-plan")).toBe(false)
    expect(tracker.stateFor("sess-a").hasPlanArtifact()).toBe(false)
  })
})

describe("createSkillInvocationTracker - plan-artifact reference counting", () => {
  function toolResult(toolName: string, input: Record<string, unknown>, isError = false) {
    return { type: "tool_result", toolCallId: "c9", toolName, input, content: [], isError }
  }

  test("#given three reads of plan A and one edit of plan B #when references are queried #then counts accumulate per path with the most-referenced first", async () => {
    // given
    const pi = new FakeExtensionAPI()
    const tracker = createSkillInvocationTracker(pi)

    // when
    await pi.dispatch("tool_result", toolResult("read", { path: "/repo/.omo/plans/alpha.md" }), CTX_A)
    await pi.dispatch("tool_result", toolResult("read", { path: "/repo/.omo/plans/alpha.md" }), CTX_A)
    await pi.dispatch("tool_result", toolResult("read", { path: "/repo/.omo/plans/alpha.md" }), CTX_A)
    await pi.dispatch("tool_result", toolResult("edit", { path: "/repo/.omo/plans/beta.md" }), CTX_A)

    // then
    const state = tracker.stateFor("sess-a")
    expect(state.hasPlanArtifact()).toBe(true)
    expect(state.planArtifactReferences()).toEqual([
      { path: "/repo/.omo/plans/alpha.md", count: 3, lastTouchedAt: 3 },
      { path: "/repo/.omo/plans/beta.md", count: 1, lastTouchedAt: 4 },
    ])
  })

  test("#given apply_patch events mentioning plan paths #when they arrive #then each distinct path counts once per event", async () => {
    // given
    const pi = new FakeExtensionAPI()
    const tracker = createSkillInvocationTracker(pi)
    const patch =
      "*** Begin Patch\n" +
      "*** Update File: .omo/plans/alpha.md\n" +
      "@@ see .omo/plans/alpha.md and .omo/plans/beta.md\n" +
      "*** End Patch"

    // when
    await pi.dispatch("tool_result", toolResult("apply_patch", { input: patch }), CTX_A)

    // then equal counts fall to the recency tie-break (beta touched later sorts first)
    expect(tracker.stateFor("sess-a").planArtifactReferences()).toEqual([
      { path: ".omo/plans/beta.md", count: 1, lastTouchedAt: 2 },
      { path: ".omo/plans/alpha.md", count: 1, lastTouchedAt: 1 },
    ])

    // when a second patch touches alpha again
    await pi.dispatch(
      "tool_result",
      toolResult("apply_patch", { input: "*** Begin Patch\n*** Delete File: .omo/plans/alpha.md\n*** End Patch" }),
      CTX_A,
    )

    // then alpha pulls ahead by count
    expect(tracker.stateFor("sess-a").planArtifactReferences()).toEqual([
      { path: ".omo/plans/alpha.md", count: 2, lastTouchedAt: 3 },
      { path: ".omo/plans/beta.md", count: 1, lastTouchedAt: 2 },
    ])
  })

  test("#given two plans touched once each #when references are queried #then the most recently touched wins the tie until one pulls ahead", async () => {
    // given
    const pi = new FakeExtensionAPI()
    const tracker = createSkillInvocationTracker(pi)

    // when
    await pi.dispatch("tool_result", toolResult("read", { path: "/repo/.omo/plans/alpha.md" }), CTX_A)
    await pi.dispatch("tool_result", toolResult("read", { path: "/repo/.omo/plans/beta.md" }), CTX_A)

    // then the recency tie-break puts beta first on a monotonically increasing sequence
    const tied = tracker.stateFor("sess-a").planArtifactReferences()
    expect(tied.map((ref) => ref.path)).toEqual(["/repo/.omo/plans/beta.md", "/repo/.omo/plans/alpha.md"])
    expect(tied[0]?.lastTouchedAt).toBeGreaterThan(tied[1]?.lastTouchedAt ?? 0)

    // when alpha is touched again
    await pi.dispatch("tool_result", toolResult("read", { path: "/repo/.omo/plans/alpha.md" }), CTX_A)

    // then count outranks recency
    expect(tracker.stateFor("sess-a").planArtifactReferences().map((ref) => [ref.path, ref.count])).toEqual([
      ["/repo/.omo/plans/alpha.md", 2],
      ["/repo/.omo/plans/beta.md", 1],
    ])
  })

  test("#given plan touches followed by session shutdown #when references are queried #then the map is cleared", async () => {
    // given
    const pi = new FakeExtensionAPI()
    const tracker = createSkillInvocationTracker(pi)
    await pi.dispatch("tool_result", toolResult("write", { path: ".omo/plans/x.md" }), CTX_A)

    // when
    await pi.dispatch("session_shutdown", {}, CTX_A)

    // then
    expect(tracker.stateFor("sess-a").planArtifactReferences()).toEqual([])
    expect(tracker.stateFor("sess-a").hasPlanArtifact()).toBe(false)
  })

  test("#given an unknown session id #when references are queried #then it reports none and no artifact", () => {
    // given
    const pi = new FakeExtensionAPI()
    const tracker = createSkillInvocationTracker(pi)

    // when / then
    expect(tracker.stateFor("sess-unknown").planArtifactReferences()).toEqual([])
    expect(tracker.stateFor("sess-unknown").hasPlanArtifact()).toBe(false)
  })

  test("#given windows and posix spellings of the same plan path #when both arrive #then they merge into one normalized reference", async () => {
    // given
    const pi = new FakeExtensionAPI()
    const tracker = createSkillInvocationTracker(pi)

    // when
    await pi.dispatch("tool_result", toolResult("read", { path: "C:\\repo\\.omo\\plans\\win.md" }), CTX_A)
    await pi.dispatch("tool_result", toolResult("read", { path: "C:/repo/.omo/plans/win.md" }), CTX_A)

    // then
    expect(tracker.stateFor("sess-a").planArtifactReferences()).toEqual([
      { path: "C:/repo/.omo/plans/win.md", count: 2, lastTouchedAt: 2 },
    ])
  })

  test("#given the same plan suffix under two worktree roots #when both arrive #then the roots stay distinct", async () => {
    // given
    const pi = new FakeExtensionAPI()
    const tracker = createSkillInvocationTracker(pi)

    // when
    await pi.dispatch("tool_result", toolResult("read", { path: "/wt/one/.omo/plans/a.md" }), CTX_A)
    await pi.dispatch("tool_result", toolResult("read", { path: "/wt/two/.omo/plans/a.md" }), CTX_A)

    // then
    const refs = tracker.stateFor("sess-a").planArtifactReferences()
    expect(refs).toHaveLength(2)
    expect(refs.every((ref) => ref.count === 1)).toBe(true)
    expect(refs.map((ref) => ref.path).sort()).toEqual(["/wt/one/.omo/plans/a.md", "/wt/two/.omo/plans/a.md"])
  })
})
