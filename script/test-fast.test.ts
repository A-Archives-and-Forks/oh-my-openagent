import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import {
  childEnv,
  createChildRegistry,
  isReentry,
  type KillProcessGroup,
  REENTRY_ENV_VAR,
  runTestFast,
  shutdownChildren,
  signalExitCode,
  testFastGroups,
  type TestFastGroup,
} from "./test-fast"

describe("isReentry", () => {
  it("#given an env without the active marker #when the guard is asked #then it reports no re-entry", () => {
    // given
    const env = { PATH: "/usr/bin" }

    // when
    const reentry = isReentry(env)

    // then
    expect(reentry).toBe(false)
  })

  it("#given an env carrying the active marker #when the guard is asked #then it reports re-entry", () => {
    // given
    const env = { [REENTRY_ENV_VAR]: "1" }

    // when
    const reentry = isReentry(env)

    // then
    expect(REENTRY_ENV_VAR).toBe("OMO_TEST_FAST_ACTIVE")
    expect(reentry).toBe(true)
  })

  it("#given the marker set to an empty string #when the guard is asked #then it reports no re-entry", () => {
    // given
    const env = { [REENTRY_ENV_VAR]: "" }

    // when
    const reentry = isReentry(env)

    // then
    expect(reentry).toBe(false)
  })
})

describe("childEnv", () => {
  it("#given a parent env #when a group child env is built #then the parent entries survive and the marker is added", () => {
    // given
    const parent = { PATH: "/usr/bin", CI: "true" }

    // when
    const env = childEnv(parent)

    // then
    expect(env.PATH).toBe("/usr/bin")
    expect(env.CI).toBe("true")
    expect(env[REENTRY_ENV_VAR]).toBe("1")
    expect(isReentry(env)).toBe(true)
  })
})

describe("child registry", () => {
  const fakeChild = (pid: number, selfKills: string[]) => ({
    pid,
    kill: (signal: NodeJS.Signals) => {
      selfKills.push(`${pid}:${signal}`)
      return true
    },
  })

  it("#given two live POSIX children #when the registry kills all #then each process group receives the negated pid", () => {
    // given
    const registry = createChildRegistry("linux")
    const groupKills: string[] = []
    const selfKills: string[] = []
    registry.add(fakeChild(101, selfKills))
    registry.add(fakeChild(202, selfKills))

    // when
    registry.killAll("SIGINT", (pid, signal) => groupKills.push(`${pid}:${signal}`))

    // then
    expect(groupKills).toEqual(["-101:SIGINT", "-202:SIGINT"])
    expect(selfKills).toEqual([])
  })

  it("#given win32 has no process groups #when the registry kills all #then it falls back to killing each child handle", () => {
    // given
    const registry = createChildRegistry("win32")
    const groupKills: string[] = []
    const selfKills: string[] = []
    registry.add(fakeChild(101, selfKills))

    // when
    registry.killAll("SIGTERM", (pid, signal) => groupKills.push(`${pid}:${signal}`))

    // then
    expect(selfKills).toEqual(["101:SIGTERM"])
    expect(groupKills).toEqual([])
  })

  it("#given a child that already exited #when the registry kills all #then the reaped child is not signalled", () => {
    // given
    const registry = createChildRegistry("linux")
    const groupKills: number[] = []
    const selfKills: string[] = []
    const first = fakeChild(101, selfKills)
    registry.add(first)
    registry.add(fakeChild(202, selfKills))
    registry.remove(first)

    // when
    registry.killAll("SIGTERM", (pid) => groupKills.push(pid))

    // then
    expect(groupKills).toEqual([-202])
  })

  it("#given a kill that throws ESRCH for a raced child #when the registry kills all #then the remaining children are still signalled", () => {
    // given
    const registry = createChildRegistry("linux")
    const groupKills: number[] = []
    const selfKills: string[] = []
    registry.add(fakeChild(101, selfKills))
    registry.add(fakeChild(202, selfKills))

    // when
    registry.killAll("SIGINT", (pid) => {
      if (pid === -101) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" })
      groupKills.push(pid)
    })

    // then
    expect(groupKills).toEqual([-202])
  })
})

describe("shutdownChildren", () => {
  it("#given children that exit during the grace period #when the parent shuts down #then no SIGKILL escalation happens", async () => {
    // given
    const registry = createChildRegistry("linux")
    const sent: string[] = []
    const child = { pid: 101, kill: () => true }
    registry.add(child)
    const kill: KillProcessGroup = (pid, signal) => void sent.push(`${pid}:${signal}`)

    // when — the grace wait is where a real child's "exit" event lands
    await shutdownChildren(registry, "SIGINT", kill, async () => registry.remove(child))

    // then
    expect(sent).toEqual(["-101:SIGINT"])
  })

  it("#given a child still alive after the grace period #when the parent shuts down #then it is SIGKILLed before the parent exits", async () => {
    // given
    const registry = createChildRegistry("linux")
    const sent: string[] = []
    registry.add({ pid: 101, kill: () => true })

    // when
    await shutdownChildren(
      registry,
      "SIGTERM",
      (pid, signal) => sent.push(`${pid}:${signal}`),
      async () => {},
    )

    // then
    expect(sent).toEqual(["-101:SIGTERM", "-101:SIGKILL"])
  })
})

describe("signalExitCode", () => {
  it("#given a termination signal #when the exit code is derived #then it follows the 128+n convention", () => {
    // given / when / then
    expect(signalExitCode("SIGINT")).toBe(130)
    expect(signalExitCode("SIGTERM")).toBe(143)
  })
})

describe("partition tiling", () => {
  const quotedPatterns = (config: string): readonly string[] =>
    [...config.matchAll(/"([^"]+\/\*\*)"/g)].map((match) => match[1] ?? "")

  const packageDir = (value: string): string | undefined =>
    /^(packages\/[^/]+)/.exec(value)?.[1]

  it("#given win2 hides what the sibling groups own #when the two configs are diffed #then the extra ignores tile the non-root-rest groups exactly", () => {
    // given
    const base = readFileSync(new URL("../bunfig.toml", import.meta.url), "utf8")
    const win2 = readFileSync(new URL("../bunfig.win2.toml", import.meta.url), "utf8")
    const basePatterns = new Set(quotedPatterns(base))

    // when
    const extraDirs = new Set(
      quotedPatterns(win2)
        .filter((pattern) => !basePatterns.has(pattern))
        .map(packageDir)
        .filter((dir): dir is string => dir !== undefined),
    )
    const groupDirs = new Set(
      testFastGroups()
        .filter((group) => group.name !== "root-rest")
        .flatMap((group) => group.args.map(packageDir))
        .filter((dir): dir is string => dir !== undefined),
    )

    // then — no gap (a package no group runs) and no overlap (a package two groups run)
    expect([...extraDirs].sort()).toEqual([...groupDirs].sort())
    expect(groupDirs.size).toBeGreaterThan(0)
  })

  it("#given every base ignore is unconditional #when win2 is read #then it keeps all of them", () => {
    // given
    const base = readFileSync(new URL("../bunfig.toml", import.meta.url), "utf8")
    const win2 = readFileSync(new URL("../bunfig.win2.toml", import.meta.url), "utf8")

    // when
    const win2Patterns = quotedPatterns(win2)

    // then
    for (const pattern of quotedPatterns(base)) expect(win2Patterns).toContain(pattern)
  })

  it("#given each package is owned by one group #when the sibling groups are listed #then no package dir repeats", () => {
    // given
    const siblingArgs = testFastGroups()
      .filter((group) => group.name !== "root-rest")
      .flatMap((group) => group.args.map(packageDir))
      .filter((dir): dir is string => dir !== undefined)

    // when
    const unique = new Set(siblingArgs)

    // then
    expect(unique.size).toBe(siblingArgs.length)
  })
})

describe("runTestFast", () => {
  const capturingLogger = (lines: string[]) => (line: string) => void lines.push(line)

  it("#given three fixed test groups #when the runner starts #then every group is launched before any exit is released", async () => {
    // given
    const order: string[] = []
    const spawnGroup = async (group: TestFastGroup) => {
      order.push(`start:${group.name}`)
      await Promise.resolve()
      order.push(`exit:${group.name}`)
      return 0
    }

    // when
    const exit = await runTestFast(spawnGroup, capturingLogger([]))

    // then
    expect(testFastGroups().length).toBe(3)
    expect(order.indexOf("start:senpi")).toBeLessThan(
      order.indexOf("exit:opencode-memory"),
    )
    expect(exit).toBe(0)
  })

  it("#given one nonzero group exit #when the runner aggregates #then the combined exit is 1", async () => {
    // given
    const spawnGroup = async (group: TestFastGroup) =>
      group.name === "root-rest" ? 3 : 0

    // when
    const exit = await runTestFast(spawnGroup, capturingLogger([]))

    // then
    expect(exit).toBe(1)
  })

  it("#given an injected logger #when the runner starts #then the banner goes to the logger and never to stdout", async () => {
    // given
    const lines: string[] = []
    const stdoutWrites: string[] = []
    const originalWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdoutWrites.push(String(chunk))
      return true
    }) as typeof process.stdout.write

    // when
    try {
      await runTestFast(async () => 0, capturingLogger(lines))
    } finally {
      process.stdout.write = originalWrite
    }

    // then
    expect(lines).toEqual([
      "[test-fast] running 3 groups in parallel: opencode-memory, root-rest, senpi",
    ])
    expect(stdoutWrites.join("")).not.toContain("[test-fast]")
  })
})
