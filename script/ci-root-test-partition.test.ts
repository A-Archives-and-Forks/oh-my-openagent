import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import {
  ROOT_TEST_SERIAL_QUARANTINE_PATHS,
  serialQuarantineCommand,
} from "./root-test-serial-quarantine.ts"

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8")
const rootConfig = readFileSync(new URL("../bunfig.root.toml", import.meta.url), "utf8")
const rootParallelConfigPath = new URL("../bunfig.root.parallel.toml", import.meta.url)
const win2ConfigPath = new URL("../bunfig.win2.toml", import.meta.url)
const win2ParallelConfigPath = new URL("../bunfig.win2.parallel.toml", import.meta.url)

function quarantinedTestPaths(config: string): readonly string[] {
  return [...config.matchAll(/"([^"]+\.test\.ts)"/g)].map((match) => match[1] ?? "")
}

function escapeForRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function rootTestJob(): string {
  const start = workflow.indexOf("  test:\n")
  const end = workflow.indexOf("\n  typecheck:", start)
  if (start < 0 || end < 0) throw new Error("root test job not found")
  return workflow.slice(start, end)
}

function quotedPatterns(config: string): readonly string[] {
  return [...config.matchAll(/"([^"]+\/\*\*)"/g)].map((match) => match[1] ?? "")
}

describe("root test CI partition", () => {
  test("#given required status check names #when the root matrix is declared #then only os and shard appear", () => {
    const job = rootTestJob()
    const start = job.indexOf("include:")
    const end = job.indexOf("steps:", start)
    const matrix = job.slice(start, end)

    expect(matrix).toContain("- os: ubuntu-latest")
    expect(matrix).toContain("- os: macos-latest")
    expect(matrix).toContain('shard: "1/2"')
    expect(matrix).toContain('shard: "2/2"')
    expect(matrix).not.toContain("config:")
    expect(matrix).not.toContain("test_args:")
    expect(matrix).not.toContain("parallel_args:")
  })

  test("#given global zauc mocks #when Windows root tests are partitioned #then omo-opencode stays in one process", () => {
    const job = rootTestJob()

    expect(job).toContain("bun test packages/omo-opencode packages/memory-core")
    expect(job).toContain("bun --config=bunfig.win2.parallel.toml test --parallel")
    expect(existsSync(win2ConfigPath)).toBe(true)
    expect(existsSync(win2ParallelConfigPath)).toBe(true)
    expect(quotedPatterns(readFileSync(win2ConfigPath, "utf8"))).toContain("packages/omo-opencode/**")
    expect(quotedPatterns(readFileSync(win2ConfigPath, "utf8"))).toContain("packages/memory-core/**")
  })

  test("#given the shared quarantine module #when a parallel leg is rendered #then its serial command lists exactly those files", () => {
    const job = rootTestJob()
    const serialCommand = serialQuarantineCommand()

    expect(ROOT_TEST_SERIAL_QUARANTINE_PATHS.length).toBeGreaterThan(0)
    // Both parallel legs (POSIX and Windows shard 2) run the same serial list,
    // so a file added to or dropped from the module must move both legs.
    expect([...job.matchAll(new RegExp(escapeForRegExp(serialCommand), "g"))]).toHaveLength(2)
  })

  test("#given the shared quarantine module #when the parallel bunfigs are read #then each ignores exactly the quarantined files", () => {
    expect(existsSync(rootParallelConfigPath)).toBe(true)
    expect(existsSync(win2ParallelConfigPath)).toBe(true)

    for (const configPath of [rootParallelConfigPath, win2ParallelConfigPath]) {
      expect(quarantinedTestPaths(readFileSync(configPath, "utf8"))).toEqual([
        ...ROOT_TEST_SERIAL_QUARANTINE_PATHS,
      ])
    }
  })

  test("#given bunfig.root.parallel.toml #when the POSIX leg parallelizes #then it keeps every bunfig.root.toml exclusion", () => {
    const parallelPatterns = quotedPatterns(readFileSync(rootParallelConfigPath, "utf8"))

    for (const pattern of quotedPatterns(rootConfig)) {
      expect(parallelPatterns).toContain(pattern)
    }
  })

  test("#given the Linux and macOS legs #when root tests run #then the quarantine precedes the parallel remainder", () => {
    const job = rootTestJob()
    const posixStep = job.slice(
      job.indexOf("runner.os != 'Windows'"),
      job.indexOf("matrix.shard == '1/2'"),
    )

    expect(posixStep).toContain(serialQuarantineCommand())
    expect(posixStep).toContain("bun --config=bunfig.root.parallel.toml test --parallel")
    expect(posixStep.indexOf(serialQuarantineCommand())).toBeLessThan(
      posixStep.indexOf("bun --config=bunfig.root.parallel.toml test --parallel"),
    )
  })

  test("#given the dedicated Senpi compatibility job #when root tests run #then omo-senpi is excluded on every OS", () => {
    expect(quotedPatterns(rootConfig)).toContain("packages/omo-senpi/**")
    expect(quotedPatterns(readFileSync(rootParallelConfigPath, "utf8"))).toContain(
      "packages/omo-senpi/**",
    )
    expect(quotedPatterns(readFileSync(win2ConfigPath, "utf8"))).toContain("packages/omo-senpi/**")
  })

  test("#given 2-core hosted runners #when a parallel leg is rendered #then isolate-per-file mode is disabled and concurrency is capped", () => {
    const job = rootTestJob()
    // `bun test --parallel` implies --isolate, which re-runs the heavy preload
    // (omo-opencode graph + pi-tui/senpi barrel warm) per test file. Across
    // ~1,550 files that is tens of minutes of pure overhead plus per-file
    // registry churn, which OOM-kills the 7 GB ubuntu runner at ~8 min and
    // pushes macOS past its 30 min timeout. The suite has always tolerated a
    // shared registry (plain serial `bun test` ran that way for years), and
    // cross-process isolation is already owned by the quarantine list plus
    // per-worker XDG/HOME, so --no-isolate restores the proven semantics.
    const parallelCommands = [...job.matchAll(/bun --config=\S+ test --parallel[^\n]*/g)].map(
      (match) => match[0],
    )

    expect(parallelCommands).toHaveLength(2)
    for (const command of parallelCommands) {
      expect(command).toContain("--no-isolate")
      expect(command).toContain("--max-concurrency=8")
    }
  })

  test("#given measured package groups #when the matrix command is rendered #then native file sharding is not used", () => {
    const job = rootTestJob()

    expect(job).not.toContain("--shard=")
    expect(job).not.toContain("--path-ignore-patterns=")
    expect(job).not.toContain("format('-c {0}'")
    expect(job).not.toContain("bun test -c")
  })

  test("#given Windows hook tests read process platform #when root tests run #then bun is not launched under Git Bash", () => {
    const job = rootTestJob()
    const runBlock = job.slice(job.indexOf("      - name: Run tests"))

    expect(runBlock).toContain("if: needs.ci-mode.outputs.run_heavy == 'true' && runner.os != 'Windows'")
    expect(runBlock).toContain("if: needs.ci-mode.outputs.run_heavy == 'true' && matrix.shard == '1/2'")
    expect(runBlock).toContain("if: needs.ci-mode.outputs.run_heavy == 'true' && matrix.shard == '2/2'")
    expect(runBlock).not.toContain("shell: bash\n        run: |")
    expect(job).toContain("timeout-minutes: ${{ matrix.os == 'windows-latest' && 60 || 30 }}")
  })

  test("#given Windows cache restore costs more than install #when the root matrix runs #then only non-Windows jobs restore Bun cache", () => {
    const job = rootTestJob()
    const cacheStart = job.indexOf("      - uses: actions/cache@v5")
    const cacheEnd = job.indexOf("      - name: Install dependencies", cacheStart)
    const cacheStep = job.slice(cacheStart, cacheEnd)

    expect(cacheStep).toContain("if: runner.os != 'Windows' && needs.ci-mode.outputs.run_heavy == 'true'")
  })
})
