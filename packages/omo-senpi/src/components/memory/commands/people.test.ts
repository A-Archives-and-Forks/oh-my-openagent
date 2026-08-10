import { afterEach, describe, expect, test } from "bun:test"
import { rm } from "node:fs/promises"

import { MemoryFakeExtensionAPI, memorySettings } from "../memory.test-support"
import { fakeCommandContext, fakeDeps, invoke, seededRepo, tempIdentity } from "./commands.test-support"
import {
  OBSERVATIONS_PER_LEVEL,
  derivePeopleGraph,
  registerPeopleCommand,
  resolvePersonQuery,
  selectObservations,
} from "./people"
import type { PeopleAskEvidence, PeopleAskRequest } from "./people-ask"
import { registerMemoryCommands } from "./register"
import type { MemoryCommandIdentity } from "./types"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const LIMITS = { maxEntries: 40, maxEntryChars: 200 } as const

const HUMAN_CARD = [
  "---",
  "description: who the user is",
  "kind: person",
  'aliases: ["Boss"]',
  "---",
  "",
  "IDENTITY: the person you work with",
  "RELATIONSHIP: works-with: jane-doe",
  "RELATIONSHIP: mentors: sam-rivers",
  "",
].join("\n")

const JANE_CARD = [
  "---",
  "description: Person - Jane Doe",
  "kind: person",
  'aliases: ["Jane","JD"]',
  "---",
  "",
  "IDENTITY: staff engineer",
  "ATTRIBUTE: prefers small diffs",
  "RELATIONSHIP: reports-to: human",
  "",
].join("\n")

const SAM_CARD = [
  "---",
  "description: Person - Sam Rivers",
  "kind: person",
  "---",
  "",
  "IDENTITY: designer",
  "RELATIONSHIP: collaborates: unknown-person",
  "",
].join("\n")

/** A person whose record holds nothing at all: no card entry, no observation ledger. */
const BLANK_CARD = ["---", "description: Person - Nia Blank", "kind: person", "---", ""].join("\n")

function observationsFile(count: number): string {
  const lines = ["---", "description: Observations - Jane Doe", "---", "", "## Explicit", ""]
  for (let index = 0; index < count; index += 1) {
    const day = String(index + 1).padStart(2, "0")
    lines.push(`- [2026-03-${day}] explicit note ${index + 1} <!-- src: s-${index + 1} -->`)
  }
  lines.push("", "## Inductive", "", "- [2026-01-05] tends to review in the morning <!-- pattern: cadence; confidence: low -->")
  return `${lines.join("\n")}\n`
}

async function peopleFixture(observationCount = 0): Promise<MemoryCommandIdentity> {
  const { root, identity } = await tempIdentity()
  tempDirs.push(root)
  await seededRepo(identity, [
    { relativePath: "system/human.md", content: HUMAN_CARD },
    { relativePath: "people/jane-doe/card.md", content: JANE_CARD },
    { relativePath: "people/sam-rivers/card.md", content: SAM_CARD },
    { relativePath: "people/nia-blank/card.md", content: BLANK_CARD },
    ...(observationCount === 0
      ? []
      : [{ relativePath: "people/jane-doe/observations.md", content: observationsFile(observationCount) }]),
  ])
  return identity
}

describe("people graph derivation", () => {
  test("#given three cards with four RELATIONSHIP lines #when the graph is derived #then nodes and edges match those lines exactly", async () => {
    // given
    const identity = await peopleFixture()
    const deps = fakeDeps(identity)

    // when
    const graph = await derivePeopleGraph(deps, identity, LIMITS)

    // then
    expect(graph.nodes.map((node) => node.slug).sort()).toEqual(["human", "jane-doe", "nia-blank", "sam-rivers"])
    expect(graph.edges).toEqual([
      { source: "human", predicate: "works-with", target: "jane-doe", targetSlug: "jane-doe" },
      { source: "human", predicate: "mentors", target: "sam-rivers", targetSlug: "sam-rivers" },
      { source: "jane-doe", predicate: "reports-to", target: "human", targetSlug: "human" },
      { source: "sam-rivers", predicate: "collaborates", target: "unknown-person", targetSlug: undefined },
    ])
  }, 30_000)

  test("#given a repository without any card #when the graph is derived #then it holds no node and no edge", async () => {
    // given
    const { root, identity } = await tempIdentity()
    tempDirs.push(root)
    await seededRepo(identity, [{ relativePath: "system/persona.md", content: "---\ndescription: P\n---\nbody\n" }])
    const deps = fakeDeps(identity)

    // when
    const graph = await derivePeopleGraph(deps, identity, LIMITS)

    // then
    expect(graph.nodes).toEqual([])
    expect(graph.edges).toEqual([])
  }, 30_000)
})

describe("person query resolution", () => {
  test("#given an alias #when the query resolves #then it hits the owning slug", async () => {
    // given
    const identity = await peopleFixture()
    const graph = await derivePeopleGraph(fakeDeps(identity), identity, LIMITS)

    // when
    const resolved = resolvePersonQuery(graph.nodes, "jd")

    // then
    expect(resolved).toEqual({ kind: "hit", slug: "jane-doe" })
  }, 30_000)

  test("#given an unknown name #when the query resolves #then it misses with close slugs", async () => {
    // given
    const identity = await peopleFixture()
    const graph = await derivePeopleGraph(fakeDeps(identity), identity, LIMITS)

    // when
    const resolved = resolvePersonQuery(graph.nodes, "jane doh")

    // then
    expect(resolved).toEqual({ kind: "miss", close: ["jane-doe"] })
  }, 30_000)
})

describe("observation selection", () => {
  test("#given more observations than the per-level cap #when they are selected #then each level keeps the newest twenty, newest first", async () => {
    // given
    const identity = await peopleFixture(25)
    const deps = fakeDeps(identity)

    // when
    const groups = await selectObservations(deps, identity, "jane-doe", LIMITS, { all: false })

    // then
    const explicit = groups.find((group) => group.section === "Explicit")
    expect(OBSERVATIONS_PER_LEVEL).toBe(20)
    expect(explicit?.entries.length).toBe(20)
    expect(explicit?.entries[0]?.date).toBe("2026-03-25")
    expect(explicit?.entries.at(-1)?.date).toBe("2026-03-06")
    expect(groups.find((group) => group.section === "Inductive")?.entries.length).toBe(1)
  }, 30_000)

  test("#given the all flag #when observations are selected #then every entry survives", async () => {
    // given
    const identity = await peopleFixture(25)
    const deps = fakeDeps(identity)

    // when
    const groups = await selectObservations(deps, identity, "jane-doe", LIMITS, { all: true })

    // then
    expect(groups.find((group) => group.section === "Explicit")?.entries.length).toBe(25)
  }, 30_000)
})

describe("/people command", () => {
  test("#given a fixture repository #when /people runs #then the roster and every edge render", async () => {
    // given
    const identity = await peopleFixture()
    const pi = new MemoryFakeExtensionAPI()
    registerPeopleCommand(pi, fakeDeps(identity))
    const ctx = fakeCommandContext()

    // when
    const text = await invoke(pi, "people", "", ctx)

    // then
    for (const slug of ["human", "jane-doe", "nia-blank", "sam-rivers"]) expect(text).toContain(slug)
    expect(text).toContain("works-with")
    expect(text).toContain("reports-to")
    expect(ctx.ui.notifications.at(-1)?.message).toBe(text)
  }, 30_000)

  test("#given an unknown name #when /people runs #then close slugs are offered", async () => {
    // given
    const identity = await peopleFixture()
    const pi = new MemoryFakeExtensionAPI()
    registerPeopleCommand(pi, fakeDeps(identity))
    const ctx = fakeCommandContext()

    // when
    const text = await invoke(pi, "people", "jane doh", ctx)

    // then
    expect(text).toContain("jane-doe")
    expect(ctx.ui.notifications.at(-1)?.level).toBe("error")
  }, 30_000)

  test("#given a person with observations #when /people <name> runs #then the card and capped observations render", async () => {
    // given
    const identity = await peopleFixture(25)
    const pi = new MemoryFakeExtensionAPI()
    registerPeopleCommand(pi, fakeDeps(identity))
    const ctx = fakeCommandContext()

    // when
    const text = await invoke(pi, "people", "Jane", ctx)

    // then
    expect(text).toContain("staff engineer")
    expect(text).toContain("explicit note 25")
    expect(text).not.toContain("explicit note 5 ")
  }, 30_000)
})

describe("/people --ask", () => {
  test("#given no evidence for the person #when --ask runs #then it abstains without launching a child", async () => {
    // given
    const identity = await peopleFixture()
    const asked: PeopleAskRequest[] = []
    const pi = new MemoryFakeExtensionAPI()
    registerPeopleCommand(
      pi,
      fakeDeps(identity, {
        peopleAsk: (request) => {
          asked.push(request)
          return Promise.resolve("never reached")
        },
      }),
    )
    const ctx = fakeCommandContext()

    // when
    const text = await invoke(pi, "people", 'nia-blank --ask "does nia ship on fridays?"', ctx)

    // then
    expect(asked).toEqual([])
    expect(text).toContain("I don't know")
  }, 30_000)

  test("#given card and observation evidence #when --ask runs #then the quick child receives that evidence and its answer renders", async () => {
    // given
    const identity = await peopleFixture(3)
    const asked: PeopleAskRequest[] = []
    const pi = new MemoryFakeExtensionAPI()
    registerPeopleCommand(
      pi,
      fakeDeps(identity, {
        peopleAsk: (request) => {
          asked.push(request)
          return Promise.resolve("Jane reviews small diffs.")
        },
      }),
    )
    const ctx = fakeCommandContext()

    // when
    const text = await invoke(pi, "people", 'jane-doe --ask "how does jane review?"', ctx)

    // then
    expect(asked.length).toBe(1)
    expect(asked[0]?.question).toBe("how does jane review?")
    expect(asked[0]?.slug).toBe("jane-doe")
    const evidence = asked[0]?.evidence as PeopleAskEvidence
    expect(evidence.card.length).toBeGreaterThan(0)
    expect(evidence.observations.length).toBe(4)
    expect(text).toContain("Jane reviews small diffs.")
  }, 30_000)
})

describe("people command people.enabled gate", () => {
  test("#given people.enabled false #when /people runs #then it refuses without reading any record", async () => {
    // given
    const identity = await peopleFixture()
    const pi = new MemoryFakeExtensionAPI()
    registerMemoryCommands(
      pi,
      fakeDeps(identity, {
        loadSettings: () => ({
          settings: memorySettings({ people: { enabled: false, max_entries: 40, max_entry_chars: 200 } }),
        }),
      }),
    )
    const ctx = fakeCommandContext()

    // when
    const text = await invoke(pi, "people", "", ctx)

    // then
    expect(text).toContain("disabled")
    expect(ctx.ui.notifications.at(-1)?.level).toBe("error")
  }, 30_000)

  test("#given people.enabled true #when the suite registers #then /people is present", async () => {
    // given
    const identity = await peopleFixture()
    const pi = new MemoryFakeExtensionAPI()

    // when
    registerMemoryCommands(pi, fakeDeps(identity))

    // then
    expect(pi.commands.map((command) => command.name)).toContain("people")
  }, 30_000)
})
