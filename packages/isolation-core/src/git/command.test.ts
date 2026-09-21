import { expect, test } from "bun:test"
import { join } from "node:path"
import { fixture } from "../test-fixture"
import { GitCommandError, gitResult, runGit } from "./command"
import { IsolationUnavailableError } from "../backend"

test("a missing git binary is typed unavailable, not a generic spawn failure", async () => {
  const f = await fixture()
  let failure: unknown
  try { await runGit(["status"], { cwd: f.repoRoot, env: { PATH: join(f.root, "no-git-here") } }) } catch (error) { failure = error }
  expect(failure).toBeInstanceOf(IsolationUnavailableError)
})

test("a git terminated by a signal is a failure, never a zero exit", async () => {
  const f = await fixture()
  let failure: unknown
  // A shell alias kills git itself before it can exit normally. $PPID is not
  // POSIX (dash ignores it), so read the parent pid from /proc on Linux and
  // fall back to $PPID elsewhere.
  const kill = process.platform === "linux"
    ? `kill -9 $(awk '{print $4}' /proc/self/stat)`
    : `kill -9 $PPID`
  const alias = `alias.sigdie=!sh -c '${kill}'`
  try {
    await gitResult(f.repoRoot, ["-c", alias, "sigdie"])
  } catch (error) { failure = error }
  expect(failure).toBeInstanceOf(GitCommandError)
  expect((failure as GitCommandError).message).toContain("signal")
})

test("input written to a child that dies before reading rejects instead of crashing", async () => {
  const f = await fixture()
  let failure: unknown
  try {
    await runGit(["-c", "alias.sigdie2=!sh -c 'kill -9 $PPID'", "sigdie2"], {
      cwd: f.repoRoot, input: "payload\n",
    })
  } catch (error) { failure = error }
  expect(failure).toBeInstanceOf(Error)
})

test("a budget breach on a still-streaming child preserves the typed limit error", async () => {
  const f = await fixture()
  class BudgetError extends Error {}
  let failure: unknown
  try {
    await runGit(["-c", "alias.spam=!yes x", "spam"], { cwd: f.repoRoot, maxOutputBytes: 4096, outputLimitError: () => new BudgetError() })
  } catch (error) { failure = error }
  expect(failure).toBeInstanceOf(BudgetError)
})
