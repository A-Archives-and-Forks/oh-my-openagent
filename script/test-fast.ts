import { spawn } from "node:child_process"

export interface TestFastGroup {
  readonly name: string
  readonly args: readonly string[]
}

export type SpawnTestGroup = (group: TestFastGroup) => Promise<number>

/** Injected so unit tests capture progress lines instead of printing production output. */
export type LogLine = (line: string) => void

/** Marker exported to every spawned group so a nested run refuses to recurse. */
export const REENTRY_ENV_VAR = "OMO_TEST_FAST_ACTIVE"

export function isReentry(env: Readonly<Record<string, string | undefined>>): boolean {
  return (env[REENTRY_ENV_VAR] ?? "") !== ""
}

export function childEnv(
  parent: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  return { ...parent, [REENTRY_ENV_VAR]: "1" }
}

export function testFastGroups(): TestFastGroup[] {
  return [
    {
      name: "opencode-memory",
      args: ["test", "packages/omo-opencode", "packages/memory-core"],
    },
    { name: "root-rest", args: ["--config=bunfig.win2.toml", "test"] },
    { name: "senpi", args: ["test", "packages/omo-senpi"] },
  ]
}

/** Minimal view of a spawned child the registry needs; keeps fakes cheap in tests. */
export interface ChildHandle {
  readonly pid?: number | undefined
  kill(signal: NodeJS.Signals): boolean
}

export type KillProcessGroup = (negatedPid: number, signal: NodeJS.Signals) => void

export interface ChildRegistry {
  add(child: ChildHandle): void
  remove(child: ChildHandle): void
  hasLiveChildren(): boolean
  killAll(signal: NodeJS.Signals, kill: KillProcessGroup): void
}

const SIGNAL_NUMBERS = { SIGINT: 2, SIGTERM: 15 } as const
export type TerminationSignal = keyof typeof SIGNAL_NUMBERS

const isErrnoException = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && "code" in error && typeof error.code === "string"

export function signalExitCode(signal: TerminationSignal): number {
  return 128 + SIGNAL_NUMBERS[signal]
}

const SHUTDOWN_GRACE_MS = 5_000

/**
 * Forwards the parent's termination signal to every group, waits out a grace
 * period, then SIGKILLs whatever is still running. Without the escalation a
 * `bun test` child drains its own shutdown for seconds after the parent has
 * already exited, which is exactly the orphan this guards against.
 */
export async function shutdownChildren(
  registry: ChildRegistry,
  signal: TerminationSignal,
  kill: KillProcessGroup,
  waitGrace: () => Promise<void> = () =>
    new Promise((resolve) => void setTimeout(resolve, SHUTDOWN_GRACE_MS)),
): Promise<void> {
  registry.killAll(signal, kill)
  await waitGrace()
  if (registry.hasLiveChildren()) registry.killAll("SIGKILL", kill)
}

/**
 * Tracks live group children so a parent signal takes the whole tree down with
 * it. POSIX children are spawned detached, so signalling `-pid` reaches the
 * bun process AND everything it spawned; win32 has no process groups, so the
 * child handle kills itself.
 */
export function createChildRegistry(platform: NodeJS.Platform): ChildRegistry {
  const live = new Set<ChildHandle>()
  return {
    add: (child) => void live.add(child),
    remove: (child) => void live.delete(child),
    hasLiveChildren: () => live.size > 0,
    killAll: (signal, kill) => {
      for (const child of live) {
        if (child.pid === undefined) continue
        if (platform === "win32") {
          child.kill(signal)
          continue
        }
        try {
          kill(-child.pid, signal)
        } catch (error) {
          // The child raced us to exit; nothing left to signal.
          if (!isErrnoException(error) || error.code !== "ESRCH") throw error
        }
      }
    },
  }
}

function spawnInheritingStdio(registry: ChildRegistry, log: LogLine): SpawnTestGroup {
  return (group) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, group.args, {
        stdio: "inherit",
        env: childEnv(process.env),
        detached: process.platform !== "win32",
      })
      registry.add(child)
      child.once("error", (error) => {
        registry.remove(child)
        reject(error)
      })
      child.once("exit", (code) => {
        registry.remove(child)
        log(`[test-fast] ${group.name}: exit ${code ?? 1}`)
        resolve(code ?? 1)
      })
    })
}

export async function runTestFast(
  spawnGroup: SpawnTestGroup,
  log: LogLine = console.log,
): Promise<number> {
  const groups = testFastGroups()
  log(
    `[test-fast] running ${groups.length} groups in parallel: ${groups
      .map((group) => group.name)
      .join(", ")}`,
  )
  const exits = await Promise.all(groups.map(spawnGroup))
  return exits.every((exit) => exit === 0) ? 0 : 1
}

if (import.meta.main) {
  if (isReentry(process.env)) {
    console.error(
      `[test-fast] re-entry blocked: ${REENTRY_ENV_VAR} is set; refusing to recurse`,
    )
    process.exit(1)
  }
  const registry = createChildRegistry(process.platform)
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      console.error(`[test-fast] ${signal} received: terminating group children`)
      void shutdownChildren(registry, signal, (pid, forwarded) =>
        void process.kill(pid, forwarded),
      ).then(() => process.exit(signalExitCode(signal)))
    })
  }
  process.exitCode = await runTestFast(spawnInheritingStdio(registry, console.log))
}
