import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { OmoTaskSettingsSchema, type OmoTaskSettings } from "@oh-my-opencode/omo-config-core"

import { createIsolationRuntime, type IsolationRuntime } from "../../isolation"
import type { RunnerOutcome } from "../../runners/in-process/child-handle"
import { createTaskRecordStore, type TaskRecordStore } from "../../store"
import type { ManagedChildHandle } from "../child-handle"
import { createTaskManager } from "../manager"
import type { ChildPlanner, ManagedRunner, ManagedStartSpec, ManagerStartSpec } from "../types"
import { categoryPlanner, makeHandle, type FakeHandle } from "./manager-fakes"

const roots: string[] = []

export function cleanupIsolationProjects(): void {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
}

function run(cwd: string, argv: readonly string[]): void {
  const result = Bun.spawnSync([...argv], { cwd, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(`${argv.join(" ")} failed: ${result.stderr.toString()}`)
}

export type IsolationFixture = {
  readonly root: string
  readonly repoRoot: string
  readonly homeDir: string
  readonly projectDir: string
}

export function tempGitRepo(): IsolationFixture {
  const root = mkdtempSync(join(tmpdir(), "senpi-task-isolation-"))
  roots.push(root)
  const repoRoot = join(root, "repo")
  const homeDir = join(root, "home")
  const projectDir = join(root, "project")
  for (const dir of [repoRoot, homeDir, projectDir]) run(root, ["mkdir", "-p", dir])
  run(repoRoot, ["git", "init", "--initial-branch=main"])
  run(repoRoot, ["git", "config", "user.email", "fixture@example.com"])
  run(repoRoot, ["git", "config", "user.name", "Fixture"])
  writeFileSync(join(repoRoot, "seed.txt"), "seed\n")
  run(repoRoot, ["git", "add", "."])
  run(repoRoot, ["git", "commit", "-m", "seed"])
  return { root, repoRoot, homeDir, projectDir }
}

export type ChildEdit = { readonly path: string; readonly content: string }

/** A runner whose child actually writes into the cwd it was launched with, which is the only way a
 * clone-vs-checkout mix-up becomes observable: the assertion reads the file, not a mock call. */
export class WritingRunner implements ManagedRunner {
  readonly handles = new Map<string, FakeHandle>()
  readonly startedSpecs: ManagedStartSpec[] = []
  childPid: number | undefined = undefined

  constructor(private readonly edits: readonly ChildEdit[] = []) {}

  start(spec: ManagedStartSpec): Promise<ManagedChildHandle> {
    this.startedSpecs.push(spec)
    for (const edit of this.edits) writeFileSync(join(spec.cwd, edit.path), edit.content)
    const fake = makeHandle(spec.taskId, this.childPid)
    this.handles.set(spec.taskId, fake)
    return Promise.resolve(fake.handle)
  }

  settle(taskId: string, outcome: RunnerOutcome): void {
    const handle = this.handles.get(taskId)
    if (handle === undefined) throw new Error(`no handle for ${taskId}`)
    handle.settle(outcome)
  }
}

export function isolationSettings(overrides: Record<string, unknown> = {}): OmoTaskSettings {
  return OmoTaskSettingsSchema.parse({ global_concurrency: 0, default_concurrency: 5, max_depth: 1, ...overrides })
}

export function makeIsolationManager(options: {
  readonly fixture: IsolationFixture
  readonly runner: ManagedRunner
  readonly config?: OmoTaskSettings
  readonly planner?: ChildPlanner
  readonly isolation?: IsolationRuntime
  readonly cwd?: string
  readonly store?: TaskRecordStore
}) {
  const { fixture } = options
  const store = options.store ?? createTaskRecordStore({ project_dir: fixture.projectDir })
  const isolation = options.isolation ?? createIsolationRuntime({ homeDir: fixture.homeDir })
  const manager = createTaskManager({
    store,
    runners: { "in-process": options.runner, process: options.runner },
    planner: options.planner ?? categoryPlanner(),
    config: options.config ?? isolationSettings(),
    cwd: options.cwd ?? fixture.repoRoot,
    isolation,
  })
  return { manager, store, isolation }
}

export function isolatedSpec(overrides: Partial<ManagerStartSpec> = {}): ManagerStartSpec {
  return {
    prompt: "do the thing",
    parent_session_id: "parent-1",
    depth: 1,
    category: "quick",
    isolated: true,
    apply: true,
    merge: "patch",
    ...overrides,
  }
}
