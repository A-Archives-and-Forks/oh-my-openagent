import {
  fetchCodexUsage,
  formatCodexUsage,
  formatCodexUsageJson,
  type CodexUsageReport,
} from "@oh-my-opencode/omo-codex"

export type CodexUsageOptions = {
  readonly json: boolean
}

type CodexUsageDependencies = {
  readonly fetchUsage?: () => Promise<CodexUsageReport>
  readonly writeStdout?: (value: string) => void
  readonly writeStderr?: (value: string) => void
}

export async function codexUsage(
  options: CodexUsageOptions,
  dependencies: CodexUsageDependencies = {},
): Promise<number> {
  const fetchUsage = dependencies.fetchUsage ?? fetchCodexUsage
  const writeStdout = dependencies.writeStdout ?? ((value: string) => process.stdout.write(value))
  const writeStderr = dependencies.writeStderr ?? ((value: string) => process.stderr.write(value))

  try {
    const report = await fetchUsage()
    const output = options.json ? formatCodexUsageJson(report) : formatCodexUsage(report)
    writeStdout(`${output}\n`)
    return 0
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (options.json) {
      writeStdout(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`)
    } else {
      writeStderr(`Codex usage unavailable: ${message}\n`)
    }
    return 1
  }
}
