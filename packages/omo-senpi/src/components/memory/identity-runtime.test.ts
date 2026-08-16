import { afterEach, describe, expect, test } from "bun:test"
import { realpathSync } from "node:fs"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { buildIdentityPaths } from "@oh-my-opencode/memory-core"

import { resolveAgentHome } from "../agent-home/resolve-agent-home"
import { createMemoryIdentityContext } from "./context"
import { createIdentityRuntime } from "./identity-runtime"
import { componentContext, loadedMemoryConfig, memorySettings } from "./memory.test-support"
import type { ReflectionSandbox, ReflectionSpawnArgs } from "./worker"

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

describe("memory identity runtime", () => {
  test.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
    "#given an unresolved reflection child command #when the real lazy sandbox is constructed #then the unsandboxed escape reaches the injected logger",
    async () => {
      // given
      const root = await mkdtemp(join(tmpdir(), "omo-memory-identity-runtime-"))
      roots.push(root)
      const paths = buildIdentityPaths(root, "agent-test")
      await Promise.all([
        paths.repo,
        paths.transcripts,
        paths.reflection,
        paths.reflectionSessions,
        paths.worktrees,
      ].map((path) => mkdir(path, { recursive: true })))
      const binDir = join(root, "bin")
      await mkdir(binDir)
      const sandboxExecutable = join(binDir, process.platform === "darwin" ? "sandbox-exec" : "bwrap")
      await writeFile(sandboxExecutable, "#!/bin/sh\nexit 0\n")
      await chmod(sandboxExecutable, 0o755)
      const identity = createMemoryIdentityContext({
        identity: "agent-test",
        identityPaths: paths,
        binding: { identity: "agent-test", repoPathHash: "hash", boundAt: 1 },
      })
      const ctx = componentContext()
      const previousPath = process.env.PATH
      const previousAgentDir = process.env.SENPI_CODING_AGENT_DIR
      process.env.PATH = `${binDir}${process.platform === "win32" ? ";" : ":"}${previousPath ?? ""}`
      process.env.SENPI_CODING_AGENT_DIR = paths.runtime

      try {
        const runtime = createIdentityRuntime(identity, {
          loadConfig: () => loadedMemoryConfig(memorySettings()),
          cwd: () => root,
          resolveModelRegistry: () => undefined,
          logger: ctx.logger,
        })
        const sandbox = (runtime.runner as unknown as { options: { sandbox: ReflectionSandbox } }).options.sandbox
        const spawnArgs: ReflectionSpawnArgs = {
          runId: "reflection-run-visible",
          attempt: 1,
          hardDeadlineAt: Date.now() + 10_000,
          category: "quick",
          conversationIds: ["conversation-a"],
          model: "fixture/model",
          command: "missing-senpi",
          args: [],
          cwd: paths.worktrees,
          env: { PATH: "" },
          detached: true,
          paths: {
            sessionDir: paths.reflectionSessions,
            worktree: paths.worktrees,
            gitCommonDir: paths.repo,
            transcript: join(paths.transcripts, "transcript.json"),
            persona: join(paths.reflectionSessions, "persona.md"),
            prompt: join(paths.reflectionSessions, "prompt.md"),
          },
        }

        // when
        await sandbox(spawnArgs)

        // then
        expect(ctx.logs).toContainEqual({
          level: "warn",
          message: "memory reflection sandbox degraded",
          details: {
            identity: "agent-test",
            runId: "reflection-run-visible",
            warning: 'reflection sandbox unavailable: inner command "missing-senpi" is not absolute and could not be resolved; running unsandboxed',
          },
        })
      } finally {
        if (previousPath === undefined) delete process.env.PATH
        else process.env.PATH = previousPath
        if (previousAgentDir === undefined) delete process.env.SENPI_CODING_AGENT_DIR
        else process.env.SENPI_CODING_AGENT_DIR = previousAgentDir
      }
    },
    30_000,
  )
})

async function renderReflectionSandboxAgentDir(envShape: {
  readonly omo?: string
  readonly senpi?: string
}): Promise<{ readonly expectedAgentDirReal: string; readonly renderedArgs: readonly string[] }> {
  // given: an isolated identity root, a fake sandbox-exec/bwrap on PATH so the seatbelt profile or
  // bwrap args render, and a fake absolute inner command so the sandbox does not degrade.
  const root = await mkdtemp(join(tmpdir(), "omo-memory-agent-dir-"))
  roots.push(root)
  const paths = buildIdentityPaths(root, "agent-dir-test")
  await Promise.all(
    [paths.repo, paths.transcripts, paths.reflection, paths.reflectionSessions, paths.worktrees].map((path) =>
      mkdir(path, { recursive: true }),
    ),
  )
  const binDir = join(root, "bin")
  await mkdir(binDir)
  for (const name of [process.platform === "darwin" ? "sandbox-exec" : "bwrap", "senpi-fake"]) {
    const exe = join(binDir, name)
    await writeFile(exe, "#!/bin/sh\nexit 0\n")
    await chmod(exe, 0o755)
  }
  const snapshot = {
    PATH: process.env.PATH,
    OMO_CODING_AGENT_DIR: process.env.OMO_CODING_AGENT_DIR,
    SENPI_CODING_AGENT_DIR: process.env.SENPI_CODING_AGENT_DIR,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  }
  process.env.PATH = `${binDir}${process.platform === "win32" ? ";" : ":"}${snapshot.PATH ?? ""}`
  if (envShape.omo === undefined) delete process.env.OMO_CODING_AGENT_DIR
  else process.env.OMO_CODING_AGENT_DIR = envShape.omo
  if (envShape.senpi === undefined) delete process.env.SENPI_CODING_AGENT_DIR
  else process.env.SENPI_CODING_AGENT_DIR = envShape.senpi
  delete process.env.PI_CODING_AGENT_DIR
  delete process.env.XDG_CONFIG_HOME
  try {
    // The agent dir the source resolves via resolveAgentHome({ env: process.env }); ensure it exists
    // so canonicalPath (realpathSync) in the sandbox render succeeds.
    const agentDir = resolveAgentHome({ env: { ...process.env } })
    await mkdir(agentDir, { recursive: true })
    const identity = createMemoryIdentityContext({
      identity: "agent-dir-test",
      identityPaths: paths,
      binding: { identity: "agent-dir-test", repoPathHash: "hash", boundAt: 1 },
    })
    const runtime = createIdentityRuntime(identity, {
      loadConfig: () => loadedMemoryConfig(memorySettings()),
      cwd: () => root,
      resolveModelRegistry: () => undefined,
    })
    const sandbox = (runtime.runner as unknown as { options: { sandbox: ReflectionSandbox } }).options.sandbox
    const transformed = await sandbox({
      runId: "reflection-run-agent-dir",
      attempt: 1,
      hardDeadlineAt: Date.now() + 10_000,
      category: "quick",
      conversationIds: ["conversation-a"],
      model: "fixture/model",
      command: join(binDir, "senpi-fake"),
      args: [],
      cwd: paths.worktrees,
      env: { PATH: "" },
      detached: true,
      paths: {
        sessionDir: paths.reflectionSessions,
        worktree: paths.worktrees,
        gitCommonDir: paths.repo,
        transcript: join(paths.transcripts, "transcript.json"),
        persona: join(paths.reflectionSessions, "persona.md"),
        prompt: join(paths.reflectionSessions, "prompt.md"),
      },
    })
    return { expectedAgentDirReal: realpathSync(agentDir), renderedArgs: transformed.args }
  } finally {
    for (const [key, value] of Object.entries(snapshot)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

function sandboxGrantsAgentDir(renderedArgs: readonly string[], agentDirReal: string): boolean {
  if (process.platform === "darwin") {
    const profile = renderedArgs[1]
    return typeof profile === "string" && profile.includes(`(allow file-write* (subpath ${JSON.stringify(agentDirReal)}))`)
  }
  for (let i = 0; i + 2 < renderedArgs.length; i++) {
    if (renderedArgs[i] === "--bind" && renderedArgs[i + 1] === agentDirReal && renderedArgs[i + 2] === agentDirReal) {
      return true
    }
  }
  return false
}

describe("memory identity runtime agent-dir resolution", () => {
  test.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
    "#given a rendered reflection sandbox #when OMO_CODING_AGENT_DIR is set #then the agent-dir runtimeWrites entry equals resolveAgentHome",
    async () => {
      // given
      const omoAgentDir = await mkdtemp(join(tmpdir(), "omo-omo-agent-dir-"))
      roots.push(omoAgentDir)
      // when
      const { expectedAgentDirReal, renderedArgs } = await renderReflectionSandboxAgentDir({ omo: omoAgentDir })
      // then
      expect(sandboxGrantsAgentDir(renderedArgs, expectedAgentDirReal)).toBe(true)
    },
    30_000,
  )

  test.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
    "#given a rendered reflection sandbox #when only SENPI_CODING_AGENT_DIR is set #then the agent-dir runtimeWrites entry equals resolveAgentHome",
    async () => {
      // given
      const senpiAgentDir = await mkdtemp(join(tmpdir(), "omo-senpi-agent-dir-"))
      roots.push(senpiAgentDir)
      // when
      const { expectedAgentDirReal, renderedArgs } = await renderReflectionSandboxAgentDir({ senpi: senpiAgentDir })
      // then
      expect(sandboxGrantsAgentDir(renderedArgs, expectedAgentDirReal)).toBe(true)
    },
    30_000,
  )

  test.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
    "#given a rendered reflection sandbox #when no agent-dir env is set #then the agent-dir runtimeWrites entry equals resolveAgentHome",
    async () => {
      // given: OMO_, SENPI_ and PI_ unset; resolveAgentHome falls to its homedir fallback.
      // when
      const { expectedAgentDirReal, renderedArgs } = await renderReflectionSandboxAgentDir({})
      // then
      expect(sandboxGrantsAgentDir(renderedArgs, expectedAgentDirReal)).toBe(true)
    },
    30_000,
  )
})
