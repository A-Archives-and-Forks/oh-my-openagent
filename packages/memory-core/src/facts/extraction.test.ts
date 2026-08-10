import { afterEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createNodeGitExec, GitMemoryRepo, type GitExec } from "../git"
import { parseMemoryFile, renderMemoryFile } from "../memfs"
import { parsePeopleCard, type ObservationEntry } from "../people"
import { buildDefaultSeedFiles } from "../seeds"
import {
  applyFactsBatch,
  parseFactsExtractionJsonl,
  type FactsExtractionRecord,
} from "./extraction"

const AUTHOR = { agentId: "facts-agent", authorName: "Facts Extractor" }
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function fixture(exec?: GitExec): Promise<{ readonly dir: string; readonly repo: GitMemoryRepo }> {
  const dir = await mkdtemp(join(tmpdir(), "memory-facts-extraction-"))
  tempDirs.push(dir)
  const repo = new GitMemoryRepo({ dir, agentId: AUTHOR.agentId, ...(exec === undefined ? {} : { exec }) })
  await repo.init({ seedFiles: buildDefaultSeedFiles() })
  return { dir, repo }
}

function project(text = "The project uses Bun."): FactsExtractionRecord {
  return { scope: "project", text, date: "2026-08-10" }
}

function person(text = "Mina prefers concise reviews."): FactsExtractionRecord {
  return {
    scope: "person",
    person: { name: "Mina", aliases: ["Min"] },
    text,
    date: "2026-08-10",
  }
}

function personRecord(
  name: string,
  aliases: readonly string[],
  text: string,
  date = "2026-08-10",
): FactsExtractionRecord {
  return { scope: "person", person: { name, aliases: [...aliases] }, text, date }
}

const PEOPLE = { enabled: true, maxEntries: 40, maxEntryChars: 200 } as const
const PEOPLE_LIMITS = { maxEntries: 40, maxEntryChars: 200 } as const

async function commitPersonCard(
  repo: GitMemoryRepo,
  slug: string,
  name: string,
  aliases: readonly string[],
): Promise<void> {
  await mkdir(join(repo.dir, "people", slug), { recursive: true })
  await writeFile(
    join(repo.dir, "people", slug, "card.md"),
    renderMemoryFile({ description: `Person - ${name}`, kind: "person", aliases }, ""),
    "utf8",
  )
  await repo.commitWrite([`people/${slug}/card.md`], `test: seed ${slug} card`, AUTHOR)
}

async function commitObservations(
  repo: GitMemoryRepo,
  slug: string,
  name: string,
  body: string,
): Promise<void> {
  await mkdir(join(repo.dir, "people", slug), { recursive: true })
  await writeFile(
    join(repo.dir, "people", slug, "observations.md"),
    renderMemoryFile({ description: `Observations - ${name}` }, body),
    "utf8",
  )
  await repo.commitWrite([`people/${slug}/observations.md`], `test: seed ${slug} observations`, AUTHOR)
}

async function readExplicitEntries(dir: string, slug: string): Promise<readonly ObservationEntry[]> {
  const memory = parseMemoryFile(await readFile(join(dir, "people", slug, "observations.md"), "utf8"))
  const { card, diagnostics } = parsePeopleCard(memory.body, PEOPLE_LIMITS)
  expect(diagnostics).toEqual([])
  return card.observations?.find((group) => group.section === "Explicit")?.entries ?? []
}

describe("facts extraction JSONL validation", () => {
  test("#given valid project and person arms #when parsed #then scope remains a discriminated union", () => {
    // given
    const raw = `${JSON.stringify(project())}\n${JSON.stringify(person())}\n`

    // when
    const records = parseFactsExtractionJsonl(raw)

    // then
    expect(records).toEqual([project(), person()])
  })

  test("#given a project record carrying person #when parsed #then the whole extraction is rejected", () => {
    // given
    const raw = JSON.stringify({ ...project(), person: { name: "Mina", aliases: [] } })

    // when
    const operation = () => parseFactsExtractionJsonl(raw)

    // then
    expect(operation).toThrow("project record must not carry person")
  })

  test("#given a person record missing person #when parsed #then the whole extraction is rejected", () => {
    // given
    const raw = JSON.stringify({ scope: "person", text: "Mina prefers Bun.", date: "2026-08-10" })

    // when
    const operation = () => parseFactsExtractionJsonl(raw)

    // then
    expect(operation).toThrow("person record requires person")
  })
})

describe("atomic facts batch application", () => {
  test("#given project and resolved person records #when applied without a people policy #then one notes commit preserves both texts and trailers", async () => {
    // given
    const { dir, repo } = await fixture()

    // when
    const result = await applyFactsBatch(repo, {
      batchId: "11111111-1111-4111-8111-111111111111",
      records: [project(), person()],
    }, AUTHOR)

    // then
    expect(result.outcome).toBe("committed")
    if (result.outcome !== "committed") throw new Error("expected a committed facts batch")
    const memory = parseMemoryFile(await readFile(join(dir, "notes/facts/2026-08.md"), "utf8"))
    expect(memory.body).toContain("- [2026-08-10] The project uses Bun.")
    expect(memory.body).toContain("- [2026-08-10] Mina prefers concise reviews.")
    const [commit] = await repo.log({ range: "HEAD~1..HEAD" })
    expect(commit?.sha).toBe(result.sha)
    expect(commit?.subject).toBe("chore(facts): extract 2 facts")
    expect(commit?.trailers["Generated-By"]).toBe("facts-extractor")
    expect(commit?.trailers["Omo-Writer"]).toBe("facts-extractor")
    expect(commit?.trailers["Omo-Facts-Batch"]).toBe("11111111-1111-4111-8111-111111111111")
  })

  test("#given zero applicable records #when applied #then no commit is attempted", async () => {
    // given
    const { repo } = await fixture()
    const before = await repo.head()

    // when
    const result = await applyFactsBatch(repo, {
      batchId: "22222222-2222-4222-8222-222222222222",
      records: [],
    }, AUTHOR)

    // then
    expect(result).toEqual({ outcome: "no_facts", affectedPaths: [] })
    expect(await repo.head()).toBe(before)
  })

  test("#given git commit fails after staging #when the batch aborts #then index and working tree are restored", async () => {
    // given
    const base = createNodeGitExec()
    let rejectCommit = false
    const exec: GitExec = {
      run: async (args, options) => {
        if (rejectCommit && args.includes("commit")) {
          return { code: 1, stdout: "", stderr: "injected commit failure" }
        }
        return base.run(args, options)
      },
    }
    const { dir, repo } = await fixture(exec)
    rejectCommit = true

    // when
    const operation = applyFactsBatch(repo, {
      batchId: "33333333-3333-4333-8333-333333333333",
      records: [project()],
    }, AUTHOR)

    // then
    await expect(operation).rejects.toThrow("injected commit failure")
    expect(await repo.status()).toBe("")
    expect(await readFile(join(dir, "notes/facts/2026-08.md"), "utf8").catch(() => undefined)).toBeUndefined()
  })
})

describe("person routing alias resolution", () => {
  test("#given an existing card with a known alias #when a person fact names that alias #then it lands in the card ledger and no new directory appears", async () => {
    // given
    const { dir, repo } = await fixture()
    await commitPersonCard(repo, "mina", "Mina", ["Min"])

    // when
    const result = await applyFactsBatch(repo, {
      batchId: "44444444-4444-4444-8444-444444444444",
      records: [personRecord("Min", [], "Min is reviewing the memory plan.")],
    }, AUTHOR, { people: PEOPLE })

    // then
    expect(result.outcome).toBe("committed")
    const entries = await readExplicitEntries(dir, "mina")
    expect(entries.map((entry) => entry.content)).toEqual(["Min is reviewing the memory plan."])
    expect(entries[0]?.date).toBe("2026-08-10")
    expect(entries[0]?.n).toBeUndefined()
    expect(await readdir(join(dir, "people"))).toEqual(["mina"])
  })

  test("#given two cards whose aliases both match #when resolved #then the longest matching alias wins", async () => {
    // given
    const { dir, repo } = await fixture()
    await commitPersonCard(repo, "mina-kim", "Mina Kim", ["Min"])
    await commitPersonCard(repo, "mina-lee", "Mina Lee", ["Mina"])

    // when
    await applyFactsBatch(repo, {
      batchId: "55555555-5555-4555-8555-555555555555",
      records: [personRecord("Mina", ["Min"], "Mina reviewed the plan.")],
    }, AUTHOR, { people: PEOPLE })

    // then
    expect((await readExplicitEntries(dir, "mina-lee")).map((entry) => entry.content))
      .toEqual(["Mina reviewed the plan."])
    expect(await readFile(join(dir, "people", "mina-kim", "observations.md"), "utf8").catch(() => undefined))
      .toBeUndefined()
  })

  test("#given two cards with equal-length matching aliases #when resolved #then the smallest slug wins and the tie is logged", async () => {
    // given
    const { dir, repo } = await fixture()
    await commitPersonCard(repo, "bbb-min", "Min Bbb", ["Min"])
    await commitPersonCard(repo, "aaa-min", "Min Aaa", ["Min"])
    const ties: { alias: string; slugs: readonly string[]; chosen: string }[] = []

    // when
    await applyFactsBatch(repo, {
      batchId: "66666666-6666-4666-8666-666666666666",
      records: [personRecord("Min", [], "Min joined the platform guild.")],
    }, AUTHOR, { people: PEOPLE, onAliasTie: (tie) => ties.push(tie) })

    // then
    expect((await readExplicitEntries(dir, "aaa-min")).map((entry) => entry.content))
      .toEqual(["Min joined the platform guild."])
    expect(ties).toEqual([{ alias: "Min", slugs: ["aaa-min", "bbb-min"], chosen: "aaa-min" }])
  })

  test("#given the primary human card carries an alias #when a fact names it #then it routes to the human ledger without a new card", async () => {
    // given
    const { dir, repo } = await fixture()
    await writeFile(
      join(dir, "system", "human.md"),
      renderMemoryFile({ description: "Person - Human", kind: "person", aliases: ["Lo"] }, ""),
      "utf8",
    )
    await repo.commitWrite(["system/human.md"], "test: alias the human", AUTHOR)

    // when
    const result = await applyFactsBatch(repo, {
      batchId: "77777777-7777-4777-8777-777777777777",
      records: [personRecord("Lo", [], "Lo prefers dark themes.")],
    }, AUTHOR, { people: PEOPLE })

    // then
    expect(result.outcome).toBe("committed")
    if (result.outcome === "committed") {
      expect(result.affectedPaths).toEqual(["people/human/observations.md"])
    }
    expect((await readExplicitEntries(dir, "human")).map((entry) => entry.content))
      .toEqual(["Lo prefers dark themes."])
    expect(existsSync(join(dir, "people", "human", "card.md"))).toBe(false)
  })
})

describe("person routing reinforcement", () => {
  test("#given an existing explicit observation #when a textually equal fact arrives #then n increments and the date refreshes without a duplicate line", async () => {
    // given
    const { dir, repo } = await fixture()
    await commitPersonCard(repo, "mina", "Mina", ["Min"])
    await commitObservations(repo, "mina", "Mina", "## Explicit\n\n- [2026-08-01] Mina prefers concise reviews.\n")

    // when
    await applyFactsBatch(repo, {
      batchId: "88888888-8888-4888-8888-888888888888",
      records: [personRecord("Mina", [], "mina   prefers concise  reviews")],
    }, AUTHOR, { people: PEOPLE })

    // then
    const entries = await readExplicitEntries(dir, "mina")
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ date: "2026-08-10", content: "Mina prefers concise reviews.", n: 2 })

    // when an nfkc-folded repeat arrives
    await applyFactsBatch(repo, {
      batchId: "99999999-9999-4999-8999-999999999999",
      records: [personRecord("Min", [], "Ｍｉｎａ prefers concise reviews", "2026-08-11")],
    }, AUTHOR, { people: PEOPLE })

    // then
    const reinforced = await readExplicitEntries(dir, "mina")
    expect(reinforced).toHaveLength(1)
    expect(reinforced[0]).toMatchObject({ date: "2026-08-11", content: "Mina prefers concise reviews.", n: 3 })
  })

  test("#given an existing explicit observation #when a different fact arrives #then it appends a separate line", async () => {
    // given
    const { dir, repo } = await fixture()
    await commitPersonCard(repo, "mina", "Mina", ["Min"])
    await commitObservations(repo, "mina", "Mina", "## Explicit\n\n- [2026-08-01] Mina prefers concise reviews.\n")

    // when
    await applyFactsBatch(repo, {
      batchId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      records: [personRecord("Min", [], "Mina prefers dark themes.")],
    }, AUTHOR, { people: PEOPLE })

    // then
    const entries = await readExplicitEntries(dir, "mina")
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ date: "2026-08-01", content: "Mina prefers concise reviews." })
    expect(entries[1]).toMatchObject({ date: "2026-08-10", content: "Mina prefers dark themes." })
  })
})

describe("person routing new people", () => {
  test("#given no matching card #when a confidently named person fact arrives #then a card skeleton and ledger are created", async () => {
    // given
    const { dir, repo } = await fixture()

    // when
    const result = await applyFactsBatch(repo, {
      batchId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      records: [personRecord("Yeongyu", ["YG"], "Yeongyu reviews on Tuesdays.")],
    }, AUTHOR, { people: PEOPLE })

    // then
    expect(result.outcome).toBe("committed")
    if (result.outcome === "committed") {
      expect(result.affectedPaths).toEqual(["people/yeongyu/card.md", "people/yeongyu/observations.md"])
    }
    const card = parseMemoryFile(await readFile(join(dir, "people", "yeongyu", "card.md"), "utf8"))
    expect(card.frontmatter).toMatchObject({
      description: "Person - Yeongyu",
      kind: "person",
      aliases: ["YG"],
    })
    expect((await readExplicitEntries(dir, "yeongyu")).map((entry) => entry.content))
      .toEqual(["Yeongyu reviews on Tuesdays."])
  })

  test("#given a slug already taken by a different person #when a new person sanitizes to it #then a numeric suffix avoids the collision", async () => {
    // given
    const { dir, repo } = await fixture()
    await commitPersonCard(repo, "yeongyu", "Yeongyu Kim", ["Yoshi"])

    // when
    await applyFactsBatch(repo, {
      batchId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      records: [personRecord("Yeongyu", [], "Yeongyu joined the platform guild.")],
    }, AUTHOR, { people: PEOPLE })

    // then
    const card = parseMemoryFile(await readFile(join(dir, "people", "yeongyu-2", "card.md"), "utf8"))
    expect(card.frontmatter).toMatchObject({ description: "Person - Yeongyu", kind: "person" })
    expect((await readExplicitEntries(dir, "yeongyu-2")).map((entry) => entry.content))
      .toEqual(["Yeongyu joined the platform guild."])
    expect(await readFile(join(dir, "people", "yeongyu", "observations.md"), "utf8").catch(() => undefined))
      .toBeUndefined()
  })

  test("#given two facts about the same new person in one batch #when applied #then one card receives both entries", async () => {
    // given
    const { dir, repo } = await fixture()

    // when
    await applyFactsBatch(repo, {
      batchId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      records: [
        personRecord("Yeongyu", ["YG"], "Yeongyu reviews on Tuesdays."),
        personRecord("YG", [], "YG drafted the alias table."),
      ],
    }, AUTHOR, { people: PEOPLE })

    // then
    expect(await readdir(join(dir, "people"))).toEqual(["yeongyu"])
    expect((await readExplicitEntries(dir, "yeongyu")).map((entry) => entry.content))
      .toEqual(["Yeongyu reviews on Tuesdays.", "YG drafted the alias table."])
  })
})

describe("person routing gate and unresolved mentions", () => {
  test("#given people routing is disabled #when a person fact arrives #then it falls back to the monthly notes file", async () => {
    // given
    const { dir, repo } = await fixture()

    // when
    await applyFactsBatch(repo, {
      batchId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      records: [person()],
    }, AUTHOR, { people: { enabled: false, maxEntries: 40, maxEntryChars: 200 } })

    // then
    const memory = parseMemoryFile(await readFile(join(dir, "notes/facts/2026-08.md"), "utf8"))
    expect(memory.body).toContain("- [2026-08-10] Mina prefers concise reviews.")
    expect(existsSync(join(dir, "people", "mina"))).toBe(false)
  })

  test("#given an unresolved person mention #when applied #then the prefixed bullet is stored verbatim in monthly notes", async () => {
    // given
    const { dir, repo } = await fixture()

    // when
    await applyFactsBatch(repo, {
      batchId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      records: [{
        scope: "project",
        text: "person-unresolved: A teammate said the launch slips.",
        date: "2026-08-10",
      }],
    }, AUTHOR, { people: PEOPLE })

    // then
    const memory = parseMemoryFile(await readFile(join(dir, "notes/facts/2026-08.md"), "utf8"))
    expect(memory.body).toContain("- [2026-08-10] person-unresolved: A teammate said the launch slips.")
    expect(existsSync(join(dir, "people"))).toBe(false)
  })
})
