import { describe, expect, test } from "bun:test"
import { chmodSync, closeSync, constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, watch, writeFileSync, writeSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"

const AGENT_DIR = join(import.meta.dir, "agent")
const cleanup = join(AGENT_DIR, "cleanup.sh")
const cleanupHook = join(AGENT_DIR, "cleanup-hook.sh")
const posixBashTest = test.skipIf(process.platform === "win32")

function read(path: string): string {
  return readFileSync(path, "utf8")
}

function createFixture(workerBody: string): { readonly repo: string; readonly agentDir: string; readonly logDir: string } {
  const repo = mkdtempSync(join(tmpdir(), "omo-cleanup-hook-test-"))
  const agentDir = join(repo, "script", "agent")
  const logDir = mkdtempSync(join(tmpdir(), "omo-cleanup-hook-log-"))
  mkdirSync(agentDir, { recursive: true })
  copyFileSync(cleanupHook, join(agentDir, "cleanup-hook.sh"))
  writeFileSync(join(agentDir, "cleanup.sh"), workerBody)
  chmodSync(join(agentDir, "cleanup-hook.sh"), 0o755)
  chmodSync(join(agentDir, "cleanup.sh"), 0o755)
  return { repo, agentDir, logDir }
}

function waitForFileContent(path: string, expectedContent: string, timeoutMs = 3_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const targetName = basename(path)
    let settled = false
    const hasExpectedContent = (): boolean => {
      try {
        return read(path) === expectedContent
      } catch { // no-excuse-ok: catch -- file publication may not have happened yet
        return false
      }
    }
    const watcher = watch(dirname(path), (_eventType, filename) => {
      if ((filename === null || filename.toString() === targetName) && hasExpectedContent()) finish()
    })
    const timeout = setTimeout(() => finish(new Error(`timed out waiting for exact content in ${path}`)), timeoutMs)

    function finish(error?: Error): void {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      watcher.close()
      if (error === undefined) resolve()
      else reject(error)
    }

    if (hasExpectedContent()) finish()
  })
}

function removeFixture(fixture: { readonly repo: string; readonly logDir: string }): void {
  rmSync(fixture.repo, { recursive: true, force: true })
  rmSync(fixture.logDir, { recursive: true, force: true })
}

describe("agent cleanup and SessionEnd launcher", () => {
  test("#given cleanup scripts #when inspected #then they are executable bash with strict cleanup and deep mode", () => {
    expect(existsSync(cleanup), "script/agent/cleanup.sh must exist").toBe(true)
    expect(existsSync(cleanupHook), "script/agent/cleanup-hook.sh must exist").toBe(true)
    if (process.platform !== "win32") {
      expect((statSync(cleanup).mode & 0o111) !== 0, "cleanup.sh must be executable").toBe(true)
      expect((statSync(cleanupHook).mode & 0o111) !== 0, "cleanup-hook.sh must be executable").toBe(true)
    }
    expect(read(cleanup).startsWith("#!/usr/bin/env bash")).toBe(true)
    expect(read(cleanup)).toContain("set -euo pipefail")
    expect(read(cleanup)).toContain("--deep")
    expect(read(cleanupHook).startsWith("#!/usr/bin/env bash")).toBe(true)
  })

  posixBashTest("#given the SessionEnd launcher #when sync mode runs #then it executes cleanup and logs successfully", () => {
    const fixture = createFixture(`#!/usr/bin/env bash
printf 'worker-ran\\n' > "$CLAUDE_PROJECT_DIR/worker.marker"
printf 'worker-log\\n'
`)
    try {
      const result = Bun.spawnSync({
        cmd: ["bash", "./cleanup-hook.sh"], cwd: fixture.agentDir, stdout: "pipe", stderr: "pipe",
        env: { ...process.env, CLAUDE_PROJECT_DIR: fixture.repo, OMO_AGENT_CLEANUP_SYNC: "1", TMPDIR: fixture.logDir },
      })
      expect(result.exitCode).toBe(0)
      expect(read(join(fixture.repo, "worker.marker"))).toBe("worker-ran\n")
      expect(read(join(fixture.logDir, "oh-my-openagent-cleanup.log"))).toContain("worker-log")
    } finally {
      removeFixture(fixture)
    }
  })

  posixBashTest("#given the SessionEnd launcher #when async mode runs #then it returns before cleanup finishes", async () => {
    const fixture = createFixture(`#!/usr/bin/env bash
printf 'worker-started\\n' > "$CLAUDE_PROJECT_DIR/worker.started.tmp"
mv "$CLAUDE_PROJECT_DIR/worker.started.tmp" "$CLAUDE_PROJECT_DIR/worker.started"
IFS= read -r _ < "$CLAUDE_PROJECT_DIR/worker.release"
printf 'worker-' > "$CLAUDE_PROJECT_DIR/worker.finished.tmp"
printf 'worker-publishing\\n' > "$CLAUDE_PROJECT_DIR/worker.publishing.tmp"
mv "$CLAUDE_PROJECT_DIR/worker.publishing.tmp" "$CLAUDE_PROJECT_DIR/worker.publishing"
IFS= read -r _ < "$CLAUDE_PROJECT_DIR/worker.release"
printf 'finished\\n' >> "$CLAUDE_PROJECT_DIR/worker.finished.tmp"
mv "$CLAUDE_PROJECT_DIR/worker.finished.tmp" "$CLAUDE_PROJECT_DIR/worker.finished"
`)
    const releasePath = join(fixture.repo, "worker.release")
    const startedPath = join(fixture.repo, "worker.started")
    const publishingPath = join(fixture.repo, "worker.publishing")
    const finishedPath = join(fixture.repo, "worker.finished")
    expect(Bun.spawnSync(["mkfifo", releasePath]).exitCode).toBe(0)
    const releaseFd = openSync(releasePath, constants.O_RDWR | constants.O_NONBLOCK)
    const workerStarted = waitForFileContent(startedPath, "worker-started\n")
    try {
      const result = Bun.spawnSync({
        cmd: ["bash", "./cleanup-hook.sh"], cwd: fixture.agentDir, stdout: "pipe", stderr: "pipe", timeout: 3_000,
        env: { ...process.env, CLAUDE_PROJECT_DIR: fixture.repo, TMPDIR: fixture.logDir },
      })
      expect(result.exitCode).toBe(0)
      await workerStarted
      expect(read(startedPath)).toBe("worker-started\n")
      expect(existsSync(finishedPath)).toBe(false)

      const workerPublishing = waitForFileContent(publishingPath, "worker-publishing\n")
      writeSync(releaseFd, "release\n")
      await workerPublishing
      expect(existsSync(finishedPath)).toBe(false)

      const workerFinished = waitForFileContent(finishedPath, "worker-finished\n")
      writeSync(releaseFd, "publish\n")
      await workerFinished
      expect(read(finishedPath)).toBe("worker-finished\n")
      expect(read(join(fixture.logDir, "oh-my-openagent-cleanup.log"))).toBe("")
    } finally {
      closeSync(releaseFd)
      removeFixture(fixture)
    }
  })

  posixBashTest("#given a hostile cleanup log override #when the launcher runs #then it keeps logs in temp", () => {
    const fixture = createFixture("#!/usr/bin/env bash\nprintf 'safe-log\\n'\n")
    const hostileLog = join(fixture.repo, "host-config.toml")
    writeFileSync(hostileLog, "preserve-me\n")
    try {
      const result = Bun.spawnSync({
        cmd: ["bash", "./cleanup-hook.sh"], cwd: fixture.agentDir, stdout: "pipe", stderr: "pipe",
        env: { ...process.env, CLAUDE_PROJECT_DIR: fixture.repo, OMO_AGENT_CLEANUP_LOG: hostileLog, OMO_AGENT_CLEANUP_SYNC: "1", TMPDIR: fixture.logDir },
      })
      expect(result.exitCode).toBe(0)
      expect(read(hostileLog)).toBe("preserve-me\n")
      expect(read(join(fixture.logDir, "oh-my-openagent-cleanup.log"))).toContain("safe-log")
    } finally {
      removeFixture(fixture)
    }
  })

  test("#given cleanup.sh #when inspected for safety #then it guards repo root and never nukes source or host", () => {
    const body = read(cleanup)
    expect(body).toContain("oh-my-openagent")
    for (const pattern of ["rm -rf /", "rm -rf ~", "rm -rf $HOME", "rm -rf src", "rm -rf packages"]) {
      expect(body, `cleanup must never contain '${pattern}'`).not.toContain(pattern)
    }
  })

  posixBashTest("#given transient files in source and skipped trees #when cleanup runs #then it prunes skipped trees", () => {
    const repo = mkdtempSync(join(tmpdir(), "omo-cleanup-test-"))
    const agentDir = join(repo, "script", "agent")
    mkdirSync(join(repo, "src"), { recursive: true })
    mkdirSync(join(repo, "node_modules", "pkg"), { recursive: true })
    mkdirSync(join(repo, ".git", "objects"), { recursive: true })
    mkdirSync(agentDir, { recursive: true })
    copyFileSync(cleanup, join(agentDir, "cleanup.sh"))
    writeFileSync(join(repo, "package.json"), '{ "name": "oh-my-openagent" }\n')
    for (const [path, content] of [
      [join(repo, "src", "app.tsbuildinfo"), "source transient"], [join(repo, "src", ".DS_Store"), "source os transient"],
      [join(repo, "node_modules", "pkg", "cache.tsbuildinfo"), "dependency cache"], [join(repo, ".git", "objects", "cache.tsbuildinfo"), "git cache"],
    ]) writeFileSync(path, content)
    try {
      expect(Bun.spawnSync({ cmd: ["bash", "./cleanup.sh"], cwd: agentDir, stdout: "pipe", stderr: "pipe" }).exitCode).toBe(0)
      expect(existsSync(join(repo, "src", "app.tsbuildinfo"))).toBe(false)
      expect(existsSync(join(repo, "src", ".DS_Store"))).toBe(false)
      expect(existsSync(join(repo, "node_modules", "pkg", "cache.tsbuildinfo"))).toBe(true)
      expect(existsSync(join(repo, ".git", "objects", "cache.tsbuildinfo"))).toBe(true)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})
