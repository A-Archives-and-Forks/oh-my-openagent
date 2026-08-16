import { type ChildProcess, spawn } from "node:child_process"
import { once } from "node:events"
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createInterface } from "node:readline"

import { RpcProcessRunner } from "../../rpc-process"
import {
  type ConsoleAttachment,
  consoleAttachment,
  mainWindowHandle,
} from "./windows-console-inspection"
import { credentialDigests, isAlive } from "./windows-console-probe-state"

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const FAKE_CHILD_PATH = fileURLToPath(
  new URL("./fake-child.mjs", import.meta.url),
)
const CONSOLE_HOST_PATH = fileURLToPath(new URL("./windows-console-host.ps1", import.meta.url))
const CREDENTIAL_FILES = ["auth.json", "models.json", "settings.json", "trust.json"] as const

type ProbeMode = "visible-control" | "hidden-fixed"

type ParentReady = {
  readonly pid: number
  readonly stdioRoundTrip: true
  readonly mode: ProbeMode
}

type ProbeCase = ParentReady & {
  readonly consoleAttached: boolean
  readonly consoleAttachError: number
  readonly mainWindowHandle: number
  readonly expectedVisible: boolean
  readonly childExited: boolean
  readonly parentExitCode: number
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
  const parent = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", CONSOLE_HOST_PATH],
    {
      env: {
        ...process.env,
        OMO_PROBE_BUN: process.execPath,
        OMO_PROBE_SCRIPT: SCRIPT_PATH,
        OMO_PROBE_MODE: mode,
        OMO_PROBE_ROOT: root,
        SENPI_CODING_AGENT_DIR: join(root, "agent"),
        SENPI_CODING_AGENT_SESSION_DIR: join(root, "parent-session"),
      },
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    },
  )
  const closed = once(parent, "close", { signal: AbortSignal.timeout(15_000) })
  let stderr = ""
  parent.stderr?.setEncoding("utf8")
  parent.stderr?.on("data", (chunk: string) => {
    stderr += chunk
  })

  let ready: ParentReady | undefined
  let handle = 0
  let attachment: ConsoleAttachment | undefined
  let code: unknown
  try {
    ready = await readJsonLine<ParentReady>(parent)
    handle = mainWindowHandle(ready.pid)
    attachment = consoleAttachment(ready.pid)
  } finally {
    parent.stdin?.end("stop\n")
    ;[code] = await closed
  }

  if (ready === undefined || attachment === undefined) {
    throw new Error("probe parent did not produce its ready payload")
  }
  const parentExitCode = typeof code === "number" ? code : -1
  if (parentExitCode !== 0) {
    throw new Error(`probe parent exited ${parentExitCode}: ${stderr.trim()}`)
  }

  return {
    ...ready,
    consoleAttached: attachment.attached,
    consoleAttachError: attachment.errorCode,
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
  const credentialsBefore = credentialDigests(CREDENTIAL_FILES)
  let probeResult: {
    readonly pass: boolean
    readonly visible: ProbeCase
    readonly hidden: ProbeCase
    readonly credentialsUntouched: boolean
  } | undefined
  try {
    const visible = await runCase("visible-control", root)
    const hidden = await runCase("hidden-fixed", root)
    const credentialsAfter = credentialDigests(CREDENTIAL_FILES)
    const credentialsUntouched = JSON.stringify(credentialsBefore) === JSON.stringify(credentialsAfter)
    const pass =
      visible.consoleAttached &&
      !hidden.consoleAttached &&
      hidden.mainWindowHandle === 0 &&
      visible.stdioRoundTrip &&
      hidden.stdioRoundTrip &&
      visible.childExited &&
      hidden.childExited &&
      credentialsUntouched

    probeResult = { pass, visible, hidden, credentialsUntouched }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }

  if (probeResult === undefined) throw new Error("Windows console probe did not produce a result")
  const tempRootRemoved = !existsSync(root)
  console.log(
    JSON.stringify({
      result: probeResult.pass && tempRootRemoved ? "PASS" : "FAIL",
      visible: probeResult.visible,
      hidden: probeResult.hidden,
      isolation: {
        sandboxAgentDir: join(root, "agent"),
        callerAgentDirIgnored: true,
        credentialsUntouched: probeResult.credentialsUntouched,
        credentialFiles: CREDENTIAL_FILES,
      },
      cleanup: {
        visibleChildExited: probeResult.visible.childExited,
        hiddenChildExited: probeResult.hidden.childExited,
        tempRootRemoved,
      },
    }),
  )
  if (!probeResult.pass || !tempRootRemoved) process.exitCode = 1
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
