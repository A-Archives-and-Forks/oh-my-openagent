/**
 * Person routing for facts extraction (IC-7, IC-14, IC-15).
 *
 * Routes person-scoped records to people/<slug>/observations.md ledgers,
 * minting a card skeleton when the person is new and confidently named.
 * Alias matching is case-insensitive, longest-alias-wins, with a
 * lexicographic slug tie-break that is logged. Reinforcement equality is
 * NFKC textual, never semantic. The primary human's aliases route to
 * people/human/observations.md. The whole path is gated by people.enabled.
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { parseMemoryFile, renderMemoryFile } from "../memfs"
import {
  parsePeopleCard,
  resolveSlugCollision,
  sanitizePersonSlug,
  serializePeopleCard,
  type ObservationEntry,
  type ObservationSection,
  type PeopleLimits,
} from "../people"
import type { FactsExtractionRecord, FactsPersonReference } from "./extraction"

export interface FactsPeopleRouting {
  readonly enabled: boolean
  readonly maxEntries: number
  readonly maxEntryChars: number
}

export interface FactsAliasTie {
  readonly alias: string
  readonly slugs: readonly string[]
  readonly chosen: string
}

export interface FactsPersonTarget {
  readonly slug: string
  readonly displayName: string
  readonly isNew: boolean
  readonly person?: FactsPersonReference
}

export interface FactsRoutingPlan {
  readonly notes: ReadonlyMap<string, readonly FactsExtractionRecord[]>
  readonly observations: ReadonlyMap<string, {
    readonly target: FactsPersonTarget
    readonly records: readonly FactsExtractionRecord[]
  }>
}

interface PeopleIndexEntry {
  readonly slug: string
  readonly displayName: string
  readonly names: readonly string[]
}

type MutableObservationBucket = {
  readonly target: FactsPersonTarget
  records: FactsExtractionRecord[]
}

export async function planFactsRouting(
  repoDir: string,
  records: readonly FactsExtractionRecord[],
  people: FactsPeopleRouting | undefined,
  onAliasTie?: (tie: FactsAliasTie) => void,
): Promise<FactsRoutingPlan> {
  const notes = new Map<string, FactsExtractionRecord[]>()
  const observations = new Map<string, MutableObservationBucket>()
  const addNote = (record: FactsExtractionRecord): void => {
    const path = `notes/facts/${record.date.slice(0, 7)}.md`
    notes.set(path, [...(notes.get(path) ?? []), record])
  }
  if (people?.enabled !== true) {
    for (const record of records) addNote(record)
    return { notes, observations }
  }

  const index = await readPeopleIndex(repoDir)
  const taken = new Set(index.map((entry) => entry.slug))
  for (const record of records) {
    if (record.scope !== "person") {
      addNote(record)
      continue
    }
    let slug = resolvePersonSlug(index, record.person, onAliasTie)
    if (slug === undefined) {
      slug = resolveSlugCollision(sanitizePersonSlug(record.person.name), taken)
      taken.add(slug)
      index.push({
        slug,
        displayName: record.person.name,
        names: [record.person.name, ...record.person.aliases],
      })
      observations.set(slug, {
        target: { slug, displayName: record.person.name, isNew: true, person: record.person },
        records: [],
      })
    }
    const bucket = observations.get(slug) ?? {
      target: {
        slug,
        displayName: index.find((entry) => entry.slug === slug)?.displayName ?? slug,
        isNew: false,
      },
      records: [],
    }
    bucket.records.push(record)
    observations.set(slug, bucket)
  }
  return { notes, observations }
}

export function factsRoutingPaths(plan: FactsRoutingPlan): readonly string[] {
  const paths = [...plan.notes.keys()]
  for (const [slug, bucket] of plan.observations) {
    paths.push(`people/${slug}/observations.md`)
    if (bucket.target.isNew) paths.push(`people/${slug}/card.md`)
  }
  return paths.sort()
}

export async function writePersonTargets(
  repoDir: string,
  plan: FactsRoutingPlan,
  limits: PeopleLimits,
): Promise<void> {
  for (const [slug, bucket] of plan.observations) {
    if (bucket.target.isNew) await writeCardSkeleton(repoDir, bucket.target)
    await upsertExplicitObservations(repoDir, slug, bucket.target.displayName, bucket.records, limits)
  }
}

export function normalizeObservationText(text: string): string {
  const collapsed = text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim()
  const uncommented = collapsed.replace(/<!--[\s\S]*?-->\s*$/, "").trim()
  return uncommented.replace(/[\p{P}]+$/u, "").trim()
}

async function writeCardSkeleton(repoDir: string, target: FactsPersonTarget): Promise<void> {
  if (target.person === undefined) return
  const path = join(repoDir, "people", target.slug, "card.md")
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, renderMemoryFile({
    description: `Person - ${target.person.name}`,
    kind: "person",
    aliases: [...target.person.aliases],
  }, ""), "utf8")
}

async function upsertExplicitObservations(
  repoDir: string,
  slug: string,
  displayName: string,
  records: readonly FactsExtractionRecord[],
  limits: PeopleLimits,
): Promise<void> {
  const path = join(repoDir, "people", slug, "observations.md")
  const existing = await readFile(path, "utf8").catch(() => undefined)
  const parsed = existing === undefined
    ? { frontmatter: { description: `Observations - ${displayName}` }, body: "" }
    : parseMemoryFile(existing)
  const { card } = parsePeopleCard(parsed.body, limits)
  const groups: { section: ObservationSection; entries: ObservationEntry[] }[] =
    (card.observations ?? []).map((group) => ({ section: group.section, entries: [...group.entries] }))
  let explicit = groups.find((group) => group.section === "Explicit")
  if (explicit === undefined) {
    explicit = { section: "Explicit", entries: [] }
    groups.unshift(explicit)
  }
  for (const record of records) {
    const normalized = normalizeObservationText(record.text)
    const at = explicit.entries.findIndex(
      (entry) => normalizeObservationText(entry.content) === normalized,
    )
    if (at === -1) {
      explicit.entries.push({ date: record.date, content: record.text })
      continue
    }
    const found = explicit.entries[at]!
    explicit.entries[at] = { ...found, date: record.date, n: (found.n ?? 1) + 1 }
  }
  const body = serializePeopleCard({ entries: card.entries, observations: groups }, limits)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, renderMemoryFile(parsed.frontmatter, `${body}\n`), "utf8")
}

function resolvePersonSlug(
  index: readonly PeopleIndexEntry[],
  person: FactsPersonReference,
  onAliasTie?: (tie: FactsAliasTie) => void,
): string | undefined {
  const inputs = [person.name, ...person.aliases].map(foldAlias)
  const matches = new Map<string, { length: number; alias: string }>()
  for (const entry of index) {
    for (const name of entry.names) {
      if (!inputs.includes(foldAlias(name))) continue
      const current = matches.get(entry.slug)
      if (current === undefined || name.length > current.length) {
        matches.set(entry.slug, { length: name.length, alias: name })
      }
    }
  }
  if (matches.size === 0) return undefined
  const longest = Math.max(...[...matches.values()].map((match) => match.length))
  const winners = [...matches.entries()].filter(([, match]) => match.length === longest)
  const slugs = winners.map(([slug]) => slug).sort()
  const chosen = slugs[0]!
  if (slugs.length > 1) {
    const alias = winners.find(([slug]) => slug === chosen)?.[1].alias ?? ""
    onAliasTie?.({ alias, slugs, chosen })
  }
  return chosen
}

async function readPeopleIndex(repoDir: string): Promise<PeopleIndexEntry[]> {
  const index: PeopleIndexEntry[] = []
  const human = await readCardFrontmatter(join(repoDir, "system", "human.md"))
  if (human !== undefined) {
    index.push({
      slug: "human",
      displayName: displayNameOf(human.description, "human"),
      names: namesOf(human, "human"),
    })
  }
  const entries = await readdir(join(repoDir, "people"), { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "human") continue
    const card = await readCardFrontmatter(join(repoDir, "people", entry.name, "card.md"))
    if (card === undefined) continue
    index.push({
      slug: entry.name,
      displayName: displayNameOf(card.description, entry.name),
      names: namesOf(card, entry.name),
    })
  }
  return index
}

async function readCardFrontmatter(
  path: string,
): Promise<{ readonly description: string; readonly aliases: readonly string[] } | undefined> {
  const raw = await readFile(path, "utf8").catch(() => undefined)
  if (raw === undefined) return undefined
  try {
    const parsed = parseMemoryFile(raw)
    return { description: parsed.frontmatter.description, aliases: parsed.frontmatter.aliases ?? [] }
  } catch {
    return undefined
  }
}

function namesOf(
  card: { readonly description: string; readonly aliases: readonly string[] },
  fallback: string,
): readonly string[] {
  return [displayNameOf(card.description, fallback), ...card.aliases]
}

function displayNameOf(description: string, fallback: string): string {
  return description.replace(/^Person\s*-\s*/i, "").trim() || fallback
}

function foldAlias(value: string): string {
  return value.normalize("NFKC").toLowerCase().trim()
}
