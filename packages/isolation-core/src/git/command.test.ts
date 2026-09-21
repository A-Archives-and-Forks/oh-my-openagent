import { expect, test } from "bun:test"
import type { ChildProcess } from "node:child_process"
import { join } from "node:path"
import { fixture } from "../test-fixture"
import { GitCommandError, runGit } from "./command"
import { IsolationUnavailableError } from "../backend"

// Signal git by the pid runGit spawned instead of guessing it from shell
// ancestry inside an alias: git versions differ in how many processes sit
// between the spawned git and the alias shell, and dash has no $PPID.
const killOnSpawn = (signal: NodeJS.Signals) => (child: ChildProcess) => {
  child.once("spawn", () => {
    if (child.pid !== undefined) process.kill(child.pid, signal)
  })
}

test("a missing git binary is typed unavailable, not a generic spawn failure", async () => {
  const f = await fixture()
  let failure: unknown
  try { await runGit(["status"], { cwd: f.repoRoot, env: { PATH: join(f.root, "no-git-here") } }) } catch (error) { failure = error }
  expect(failure).toBeInstanceOf(IsolationUnavailableError)
})

test("a git terminated by a signal is a failure, never a zero exit", async () => {
  const f = await fixture()
  let failure: unknown
  try {
    await runGit(["-c", "alias.wait=!sleep 30", "wait"], {
      cwd: f.repoRoot, allowedExitCodes: Array.from({ length: 256 }, (_, code) => code), onSpawn: killOnSpawn("SIGKILL"),
    })
  } catch (error) { failure = error }
  expect(failure).toBeInstanceOf(GitCommandError)
  expect((failure as GitCommandError).message).toContain("signal")
})

test("input written to a child that dies before reading rejects instead of crashing", async () => {
  const f = await fixture()
  let failure: unknown
  try {
    await runGit(["-c", "alias.wait=!sleep 30", "wait"], { cwd: f.repoRoot, input: "payload\n", onSpawn: killOnSpawn("SIGKILL") })
  } catch (error) { failure = error }
  expect(failure).toBeInstanceOf(Error)
})

test("a budget breach on a still-streaming child preserves the typed limit error", async () => {
  const f = await fixture()
  class BudgetError extends Error {}
  let failure: unknown
  const started = Date.now()
  try {
    await runGit(["-c", "alias.spam=!yes x", "spam"], { cwd: f.repoRoot, maxOutputBytes: 4096, outputLimitError: () => new BudgetError() })
  } catch (error) { failure = error }
  expect(failure).toBeInstanceOf(BudgetError)
  // `yes` is git's grandchild through the alias shell; it must go down with
  // the tree instead of holding the pipe open until the test times out.
  expect(Date.now() - started).toBeLessThan(5_000)
})

const processGroupIsGone = async (pgid: number): Promise<boolean> => {
  for (let attempt = 0; attempt < 50; attempt++) {
    try { process.kill(-pgid, 0) } catch { return true }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return false
}

test("a budget breach tears down the writer even when the alias shell survives its child", async () => {
  const f = await fixture()
  class BudgetError extends Error {}
  let failure: unknown
  let pgid: number | undefined
  const started = Date.now()
  try {
    await runGit(["-c", "alias.spam=!sh -c 'yes x'", "spam"], {
      cwd: f.repoRoot, maxOutputBytes: 4096, outputLimitError: () => new BudgetError(),
      onSpawn: (child) => { pgid = child.pid },
    })
  } catch (error) { failure = error }
  expect(failure).toBeInstanceOf(BudgetError)
  expect(Date.now() - started).toBeLessThan(5_000)
  if (process.platform !== "win32" && pgid !== undefined) expect(await processGroupIsGone(pgid)).toBe(true)
})
