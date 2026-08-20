import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"

import { EVIDENCE_RELATIVE_ROOT, resolveEvidenceDir } from "./resolve-evidence-dir.mjs"

const cleanupRoots = []

afterEach(() => {
  for (const root of cleanupRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function makeGitRoot() {
  const root = mkdtempSync(join(tmpdir(), "senpi-qa-evidence-"))
  cleanupRoots.push(root)
  mkdirSync(join(root, ".git"))
  return root
}

describe("resolveEvidenceDir", () => {
  test("#given a git worktree and a safe slug #when resolved #then it returns the canonical adapter evidence directory", () => {
    // given
    const repoRoot = makeGitRoot()

    // when
    const resolved = resolveEvidenceDir({ repoRoot, slug: "20260820-senpi-qa-contract" })

    // then
    expect(resolved).toBe(join(repoRoot, ".omo", "evidence", "omo-senpi-adapter", "20260820-senpi-qa-contract"))
  })

  test("#given a relative git worktree path #when resolved #then it still returns an absolute evidence directory", () => {
    // given
    const repoRoot = makeGitRoot()
    const relativeRoot = relative(process.cwd(), repoRoot)

    // when
    const resolved = resolveEvidenceDir({ repoRoot: relativeRoot, slug: "20260820-relative-root" })

    // then
    expect(resolved).toBe(join(repoRoot, ".omo", "evidence", "omo-senpi-adapter", "20260820-relative-root"))
  })

  test("#given a resolved evidence path #when the resolver returns #then it has created no directory", () => {
    // given
    const repoRoot = makeGitRoot()

    // when
    const resolved = resolveEvidenceDir({ repoRoot, slug: "20260820-senpi-qa-contract" })

    // then
    expect(existsSync(resolved)).toBe(false)
    expect(existsSync(join(repoRoot, ".omo"))).toBe(false)
  })

  test("#given the adapter evidence root #when it is the declared relative root #then it stays under .omo/evidence", () => {
    // given / when / then
    expect(EVIDENCE_RELATIVE_ROOT).toBe(join(".omo", "evidence", "omo-senpi-adapter"))
  })

  test("#given an unsafe slug #when resolved #then it is rejected before any path is produced", () => {
    // given
    const repoRoot = makeGitRoot()
    const unsafeSlugs = [
      "",
      "   ",
      ".",
      "..",
      "../escape",
      "nested/slug",
      "nested\\slug",
      "/absolute",
      join(repoRoot, "absolute"),
      "local-ignore/qa-evidence/20260819-senpi",
      "..%2Fescape",
      "-leading-hyphen",
      "trailing-hyphen-",
      "Upper-Case",
      "under_score",
    ]

    // when / then
    for (const slug of unsafeSlugs) {
      expect(() => resolveEvidenceDir({ repoRoot, slug }), `must reject ${JSON.stringify(slug)}`).toThrow()
    }
  })

  test("#given a directory that is not a git worktree #when resolved #then it is rejected", () => {
    // given
    const notARepo = mkdtempSync(join(tmpdir(), "senpi-qa-not-git-"))
    cleanupRoots.push(notARepo)

    // when / then
    expect(() => resolveEvidenceDir({ repoRoot: notARepo, slug: "20260820-senpi-qa-contract" })).toThrow(/git/i)
  })

  test("#given a rejected slug #when the error surfaces #then it names the offending slug for the operator", () => {
    // given
    const repoRoot = makeGitRoot()

    // when / then
    expect(() => resolveEvidenceDir({ repoRoot, slug: "local-ignore/qa-evidence/x" })).toThrow(
      /local-ignore\/qa-evidence\/x/,
    )
  })
})
