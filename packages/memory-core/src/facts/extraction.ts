import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import type { GitCommitAuthor, GitMemoryRepo } from "../git"
import { parseMemoryFile, renderMemoryFile } from "../memfs"
import type { FactsQueueEntry } from "./schema"

export interface FactsPersonReference {
  readonly name: string
  readonly aliases: readonly string[]
}

export type FactsExtractionRecord =
  | {
      readonly scope: "person"
      readonly person: FactsPersonReference
      readonly text: string
      readonly date: string
    }
  | {
      readonly scope: "project"
      readonly text: string
      readonly date: string
    }

export interface FactsBatch {
  readonly batchId: string
  readonly records: readonly FactsExtractionRecord[]
}

export interface FactsKnownPerson {
  readonly slug: string
  readonly displayName: string
  readonly aliases: readonly string[]
}

export interface FactsPayload {
  readonly version: 1
  readonly identity: string
  readonly today: string
  readonly entries: readonly FactsQueueEntry[]
  readonly knownPeople: readonly FactsKnownPerson[]
  readonly primaryHuman: { readonly slug: "human"; readonly aliases: readonly string[] }
}

export type ApplyFactsBatchResult =
  | { readonly outcome: "committed"; readonly sha: string; readonly affectedPaths: readonly string[] }
  | { readonly outcome: "no_facts"; readonly affectedPaths: readonly [] }

export class FactsExtractionValidationError extends Error {
  override readonly name = "FactsExtractionValidationError"
}

export function parseFactsExtractionJsonl(raw: string): FactsExtractionRecord[] {
  const records: FactsExtractionRecord[] = []
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    if (line.trim().length === 0) continue
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      throw invalid(index, "line is not valid JSON")
    }
    records.push(parseRecord(value, index))
  }
  return records
}

export async function applyFactsBatch(
  repo: GitMemoryRepo,
  batch: FactsBatch,
  author: GitCommitAuthor,
): Promise<ApplyFactsBatchResult> {
  validateBatchId(batch.batchId)
  if (batch.records.length === 0) return { outcome: "no_facts", affectedPaths: [] }
  await repo.cleanCheck()

  const grouped = new Map<string, FactsExtractionRecord[]>()
  for (const record of batch.records) {
    const path = routeRecord(record)
    const records = grouped.get(path) ?? []
    records.push(record)
    grouped.set(path, records)
  }
  const affectedPaths = [...grouped.keys()].sort()
  const existed = new Set(affectedPaths.filter((path) => existsSync(join(repo.dir, path))))

  try {
    for (const [relativePath, records] of grouped) {
      await appendFactsFile(repo.dir, relativePath, records)
    }
    const count = batch.records.length
    const result = await repo.commitWrite(
      affectedPaths,
      [
        `chore(facts): extract ${count} ${count === 1 ? "fact" : "facts"}`,
        "",
        "Generated-By: facts-extractor",
        "Omo-Writer: facts-extractor",
        `Omo-Facts-Batch: ${batch.batchId}`,
      ].join("\n"),
      author,
    )
    return { outcome: "committed", sha: result.sha, affectedPaths }
  } catch (error) {
    await restoreBatch(repo.dir, affectedPaths, existed)
    throw error
  }
}

async function appendFactsFile(
  root: string,
  relativePath: string,
  records: readonly FactsExtractionRecord[],
): Promise<void> {
  const path = join(root, relativePath)
  const existing = await readFile(path, "utf8").catch(() => undefined)
  const parsed = existing === undefined
    ? { frontmatter: { description: `Explicit facts for ${relativePath.slice(-10, -3)}` }, body: "" }
    : parseMemoryFile(existing)
  const prefix = parsed.body.length === 0 || parsed.body.endsWith("\n") ? "" : "\n"
  const bullets = records.map((record) => `- [${record.date}] ${record.text}`).join("\n")
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, renderMemoryFile(parsed.frontmatter, `${parsed.body}${prefix}${bullets}\n`), "utf8")
}

export function factsBatchPaths(records: readonly FactsExtractionRecord[]): readonly string[] {
  return [...new Set(records.map(routeRecord))].sort()
}

export async function restoreFactsBatch(
  repo: GitMemoryRepo,
  records: readonly FactsExtractionRecord[],
): Promise<void> {
  const paths = factsBatchPaths(records)
  if (paths.length === 0) return
  await git(repo.dir, ["reset", "HEAD", "--", ...paths])
  for (const path of paths) {
    if (await gitSucceeds(repo.dir, ["checkout", "--", path])) continue
    await rm(join(repo.dir, path), { force: true })
  }
}

async function restoreBatch(
  repoDir: string,
  affectedPaths: readonly string[],
  existed: ReadonlySet<string>,
): Promise<void> {
  await git(repoDir, ["reset", "HEAD", "--", ...affectedPaths])
  const tracked = affectedPaths.filter((path) => existed.has(path))
  if (tracked.length > 0) await git(repoDir, ["checkout", "--", ...tracked])
  await Promise.all(
    affectedPaths
      .filter((path) => !existed.has(path))
      .map((path) => rm(join(repoDir, path), { force: true })),
  )
}

function routeRecord(record: FactsExtractionRecord): string {
  switch (record.scope) {
    case "person":
      return `notes/facts/${record.date.slice(0, 7)}.md`
    case "project":
      return `notes/facts/${record.date.slice(0, 7)}.md`
  }
}

function parseRecord(value: unknown, index: number): FactsExtractionRecord {
  if (!isRecord(value)) throw invalid(index, "record must be an object")
  const text = nonEmpty(value.text)
  const date = validDate(value.date)
  if (text === undefined) throw invalid(index, "text must be non-empty")
  if (date === undefined) throw invalid(index, "date must be YYYY-MM-DD")

  if (value.scope === "project") {
    if ("person" in value) throw invalid(index, "project record must not carry person")
    assertKeys(value, ["scope", "text", "date"], index)
    return { scope: "project", text, date }
  }
  if (value.scope === "person") {
    if (!("person" in value)) throw invalid(index, "person record requires person")
    assertKeys(value, ["scope", "person", "text", "date"], index)
    if (!isRecord(value.person)) throw invalid(index, "person must be an object")
    assertKeys(value.person, ["name", "aliases"], index)
    const name = nonEmpty(value.person.name)
    if (name === undefined || !Array.isArray(value.person.aliases)) {
      throw invalid(index, "person requires name and aliases")
    }
    const aliases = value.person.aliases.map(nonEmpty)
    if (aliases.some((alias) => alias === undefined)) {
      throw invalid(index, "person aliases must be non-empty strings")
    }
    return { scope: "person", person: { name, aliases: aliases as string[] }, text, date }
  }
  throw invalid(index, "scope must be person or project")
}

function assertKeys(value: Record<string, unknown>, allowed: readonly string[], index: number): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key))
  if (extras.length > 0) throw invalid(index, `unexpected field: ${extras[0]}`)
}

function validateBatchId(batchId: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(batchId)) {
    throw new TypeError("facts batchId must be a UUID v4")
  }
}

function validDate(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined
  return new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value ? value : undefined
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function invalid(index: number, message: string): FactsExtractionValidationError {
  return new FactsExtractionValidationError(`facts extraction line ${index + 1}: ${message}`)
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile("git", [...args], { cwd, encoding: "utf8" }, (error) => error === null ? resolve() : reject(error))
  })
}

async function gitSucceeds(cwd: string, args: readonly string[]): Promise<boolean> {
  return await new Promise((resolve) => {
    execFile("git", [...args], { cwd, encoding: "utf8" }, (error) => resolve(error === null))
  })
}
