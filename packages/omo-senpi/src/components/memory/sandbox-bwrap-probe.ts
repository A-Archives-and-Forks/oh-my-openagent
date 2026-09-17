/**
 * Whether a resolved sandbox executable can actually start a sandbox, not merely whether it exists.
 *
 * On Ubuntu 24.04+ with `kernel.apparmor_restrict_unprivileged_userns=1`, /usr/bin/bwrap is present
 * and executable while every invocation dies with `bwrap: setting up uid map: Permission denied`,
 * so an existence check alone selects a sandbox that kills every child at spawn (issue #6873).
 */
export type SandboxUsability =
  | { readonly usable: true }
  | { readonly usable: false; readonly reason: string }

export interface BwrapSmokeResult {
  readonly exitCode: number | null
  readonly timedOut: boolean
  readonly errorMessage?: string
  readonly stderr: string
}

const SMOKE_TIMEOUT_MS = 3_000
const REASON_STDERR_CHARS = 200

/**
 * The smallest invocation that still exercises user-namespace setup: bwrap must unshare and write
 * its uid/gid maps before it can exec the inner command, which is exactly the step AppArmor blocks.
 */
const SMOKE_ARGS = ["--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev", "true"] as const

export function classifyBwrapSmoke(result: BwrapSmokeResult): SandboxUsability {
  if (result.timedOut) return unusable(`smoke test timed out after ${SMOKE_TIMEOUT_MS}ms`, result.stderr)
  if (result.errorMessage !== undefined) return unusable(`smoke test could not run: ${result.errorMessage}`, result.stderr)
  if (result.exitCode === 0) return { usable: true }
  return unusable(`smoke test exited ${result.exitCode ?? "without an exit code"}`, result.stderr)
}

// One verdict per absolute executable path per process. Memoizes both the result and the promise
// to ensure a second call during a concurrent first spawn does not trigger a second spawn.
const verdicts = new Map<string, SandboxUsability>()
const pendingProbes = new Map<string, Promise<SandboxUsability>>()

export async function probeBwrapUsability(executable: string): Promise<SandboxUsability> {
  const memoized = verdicts.get(executable)
  if (memoized !== undefined) return memoized

  const pending = pendingProbes.get(executable)
  if (pending !== undefined) return pending

  const probePromise = (async () => {
    try {
      const result = await runBwrapSmoke(executable)
      const verdict = classifyBwrapSmoke(result)
      verdicts.set(executable, verdict)
      return verdict
    } finally {
      pendingProbes.delete(executable)
    }
  })()

  pendingProbes.set(executable, probePromise)
  return probePromise
}

async function runBwrapSmoke(executable: string): Promise<BwrapSmokeResult> {
  const controller = new AbortController()
  const timeoutHandle = setTimeout(() => controller.abort(), SMOKE_TIMEOUT_MS)
  try {
    const child = Bun.spawn([executable, ...SMOKE_ARGS], {
      signal: controller.signal,
      stdio: ["ignore", "ignore", "pipe"],
    })
    const exitCode = await child.exited
    const stderrBuffer = await new Response(child.stderr!).arrayBuffer()
    const stderr = new TextDecoder().decode(stderrBuffer)
    return { exitCode, timedOut: false, stderr }
  } catch (error) {
    if (error instanceof Error) {
      if (error.name === "AbortError") {
        return { exitCode: null, timedOut: true, stderr: "" }
      }
      return { exitCode: null, timedOut: false, errorMessage: error.message, stderr: "" }
    }
    return { exitCode: null, timedOut: false, errorMessage: String(error), stderr: "" }
  } finally {
    clearTimeout(timeoutHandle)
  }
}

function unusable(cause: string, stderr: string): SandboxUsability {
  const tail = stderr.trim().slice(-REASON_STDERR_CHARS)
  return { usable: false, reason: tail === "" ? cause : `${cause}: ${tail}` }
}

