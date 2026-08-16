import { type ChildProcess, spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { once } from "node:events"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { createInterface } from "node:readline"

import { RpcProcessRunner } from "../../../../packages/senpi-task/src/runners/rpc-process"

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const FAKE_CHILD_PATH = fileURLToPath(
  new URL("../../../../packages/senpi-task/src/runners/rpc/__fixtures__/fake-child.mjs", import.meta.url),
)
const CREDENTIAL_FILES = ["auth.json", "models.json", "settings.json", "trust.json"] as const

type ProbeMode = "visible-control" | "hidden-fixed"

type ParentReady = {
  readonly pid: number
  readonly stdioRoundTrip: true
  readonly mode: ProbeMode
}

type ProbeCase = ParentReady & {
  readonly mainWindowHandle: number
  readonly expectedVisible: boolean
  readonly childExited: boolean
  readonly parentExitCode: number
}

function credentialDigests(): Readonly<Record<string, string>> {
  const roots = [join(homedir(), ".omo", "agent"), join(homedir(), ".senpi", "agent")]
  const result: Record<string, string> = {}
  for (const root of roots) {
    for (const name of CREDENTIAL_FILES) {
      const path = join(root, name)
      result[path] = existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : "missing"
    }
  }
  return result
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function mainWindowHandle(pid: number): number {
  const source = `$p = Get-Process -Id ${pid} -ErrorAction Stop; [Console]::Out.Write([int64]$p.MainWindowHandle)`
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", source], {
    encoding: "utf8",
    windowsHide: true,
  })
  if (result.status !== 0) {
    throw new Error(`MainWindowHandle probe failed: ${result.stderr.trim()}`)
  }
  const handle = Number.parseInt(result.stdout.trim(), 10)
  if (!Number.isSafeInteger(handle)) {
    throw new Error(`MainWindowHandle was not an integer: ${result.stdout}`)
  }
  return handle
}

async function readJsonLine<T>(child: ChildProcess): Promise<T> {
  if (child.stdout === null) throw new Error("probe parent stdout was not piped")
  const lines = createInterface({ input: child.stdout })
  try {
    const [line] = await once(lines, "line", { signal: AbortSignal.timeout(15_000) })
    return JSON.parse(String(line)) as T
  } finally {
    lines.close()
  }
}

async function runCase(mode: ProbeMode, root: string): Promise<ProbeCase> {
  const parent = spawn(process.execPath, [SCRIPT_PATH, "--parent", mode, root], {
    cwd: dirname(SCRIPT_PATH),
    env: {
      ...process.env,
      SENPI_CODING_AGENT_DIR: join(root, "agent"),
      SENPI_CODING_AGENT_SESSION_DIR: join(root, "parent-session"),
    },
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    windowsHide: true,
  })
  let stderr = ""
  parent.stderr?.setEncoding("utf8")
  parent.stderr?.on("data", (chunk: string) => {
    stderr += chunk
  })

  const ready = await readJsonLine<ParentReady>(parent)
  const handle = mainWindowHandle(ready.pid)
  parent.stdin?.end("stop\n")
  const [code] = await once(parent, "exit", { signal: AbortSignal.timeout(15_000) })
  const parentExitCode = typeof code === "number" ? code : -1
  if (parentExitCode !== 0) {
    throw new Error(`probe parent exited ${parentExitCode}: ${stderr.trim()}`)
  }

  return {
    ...ready,
    mainWindowHandle: handle,
    expectedVisible: mode === "visible-control",
    childExited: !isAlive(ready.pid),
    parentExitCode,
  }
}

async function runParent(mode: ProbeMode, root: string): Promise<void> {
  const runner = new RpcProcessRunner({
    buildSpawn: (spec) => ({
      command: process.execPath,
      args: [FAKE_CHILD_PATH],
      cwd: spec.cwd,
      env: {
        ...process.env,
        SENPI_CODING_AGENT_DIR: join(root, "agent"),
        SENPI_CODING_AGENT_SESSION_DIR: join(root, "child-session"),
      },
    }),
    ...(mode === "visible-control"
      ? {
          spawnProcess: (command, args, options) =>
            spawn(command, [...args], {
              ...options,
              windowsHide: false,
            }),
        }
      : {}),
  })
  const handle = runner.start({
    task_id: `st_windows_probe_${mode}`,
    cwd: root,
    state_dir: join(root, "state"),
    prompt: "hold",
  })

  try {
    await handle.steer("stdio-round-trip")
    process.stdout.write(`${JSON.stringify({ pid: handle.pid, stdioRoundTrip: true, mode })}\n`)
    await once(process.stdin, "data", { signal: AbortSignal.timeout(30_000) })
  } finally {
    await handle.terminate({ sigkillDelayMs: 500 })
    await handle.waitForExit()
  }
}

async function runProbe(): Promise<void> {
  if (process.platform !== "win32") {
    console.log(JSON.stringify({ result: "SKIP", reason: "windows-only", platform: process.platform }))
    return
  }

  const root = mkdtempSync(join(tmpdir(), "omo-rpc-window-probe-"))
  mkdirSync(join(root, "agent"), { recursive: true })
  const credentialsBefore = credentialDigests()
  try {
    const visible = await runCase("visible-control", root)
    const hidden = await runCase("hidden-fixed", root)
    const credentialsAfter = credentialDigests()
    const credentialsUntouched = JSON.stringify(credentialsBefore) === JSON.stringify(credentialsAfter)
    const pass =
      visible.mainWindowHandle !== 0 &&
      hidden.mainWindowHandle === 0 &&
      visible.stdioRoundTrip &&
      hidden.stdioRoundTrip &&
      visible.childExited &&
      hidden.childExited &&
      credentialsUntouched

    console.log(
      JSON.stringify({
        result: pass ? "PASS" : "FAIL",
        visible,
        hidden,
        isolation: {
          sandboxAgentDir: join(root, "agent"),
          callerAgentDirIgnored: true,
          credentialsUntouched,
          credentialFiles: CREDENTIAL_FILES,
        },
        cleanup: {
          visibleChildExited: visible.childExited,
          hiddenChildExited: hidden.childExited,
          tempRootRemoved: true,
        },
      }),
    )
    if (!pass) process.exitCode = 1
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const parentIndex = process.argv.indexOf("--parent")
if (parentIndex >= 0) {
  const mode = process.argv[parentIndex + 1]
  const root = process.argv[parentIndex + 2]
  if ((mode !== "visible-control" && mode !== "hidden-fixed") || root === undefined) {
    throw new Error("usage: windows-console-probe.ts --parent <visible-control|hidden-fixed> <root>")
  }
  await runParent(mode, root)
} else {
  await runProbe()
}
