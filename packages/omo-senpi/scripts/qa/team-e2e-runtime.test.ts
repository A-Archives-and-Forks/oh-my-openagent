import { describe, expect, it } from "bun:test"
import { isAbsolute, join, resolve } from "node:path"

import { evaluateCrashRecovery, hasCrashLivenessEvent } from "./team-e2e-crash.mjs"
import { createOutDir, resolveSenpi, TEAM_E2E_OMO_CONFIG } from "./team-e2e.mjs"
import * as runtime from "./team-e2e-runtime.mjs"

describe("team e2e output paths", () => {
  it("#given a configured relative output path #when the capture directory is created #then it is absolute", () => {
    // given
    const configured = join(".omo", "evidence", "relative-team-e2e")

    // when
    const output = createOutDir(configured)

    // then
    expect(output).toEqual({ outDir: resolve(configured), cleanup: false })
    expect(isAbsolute(output.outDir)).toBe(true)
  })
})

describe("team e2e Senpi discovery", () => {
  it("#given native and npm Windows candidates #when discovering Senpi #then the native executable wins", () => {
    const executable = "C:\\native\\senpi.exe"

    const resolved = resolveSenpi({
      platform: "win32",
      env: { PATH: "C:\\native;C:\\npm" },
      existsSync: (path: string) => path === executable || path === "C:\\npm\\senpi.cmd",
    })

    expect(resolved).toBe(executable)
  })

  it("#given only a Windows npm shim and a backslash absolute override #when discovering Senpi #then both paths are supported", () => {
    const shim = "C:\\npm\\senpi.cmd"
    const absolute = "C:\\Tools\\Senpi\\senpi.exe"

    expect(resolveSenpi({
      platform: "win32",
      env: { PATH: "C:\\npm" },
      existsSync: (path: string) => path === shim,
    })).toBe(shim)
    expect(resolveSenpi({
      platform: "win32",
      env: { SENPI_BIN: absolute, PATH: "" },
      existsSync: (path: string) => path === absolute,
    })).toBe(absolute)
  })
})

describe("team e2e crash recovery config", () => {
  it("#given the restart-liveness scenario #when its OmO config is seeded #then dead prior members are marked lost instead of reattached", () => {
    expect(TEAM_E2E_OMO_CONFIG.task?.reattach_on_reconcile).toBe(false)
  })
})

describe("team e2e crash recovery evidence", () => {
  it("#given the member was killed and the parent already exited #when crash recovery is evaluated #then the parent is quiescent and the kill-at-hold check passes", () => {
    const checks = evaluateCrashRecovery({
      target: { ready: true },
      before: { processedExists: false, eventCount: 0 },
      memberKilled: true,
      parentTermination: { kind: "already-exited", pid: 5151, platform: "win32" },
      restartStatus: 0,
      livenessInjected: true,
      afterRestartRecord: { notification: { run_epoch: 0, liveness_notified_epoch: 0 } },
    })

    expect(checks.crashKilledMemberAtHold).toBe(true)
    expect(checks.crashLivenessAcknowledged).toBe(true)
  })

  it("#given parent tree termination failed #when crash recovery is evaluated #then the kill-at-hold check fails", () => {
    const checks = evaluateCrashRecovery({
      target: { ready: true },
      before: { processedExists: false, eventCount: 0 },
      memberKilled: true,
      parentTermination: { kind: "failed", pid: 5151, platform: "win32", status: 1, error: "still alive" },
      restartStatus: 0,
      livenessInjected: true,
      afterRestartRecord: { notification: { run_epoch: 0 } },
    })

    expect(checks.crashKilledMemberAtHold).toBe(false)
    expect(checks.crashLivenessAcknowledged).toBe(false)
  })
})

describe("team e2e crash liveness detector", () => {
  it("#given a structured crash liveness wake with error state #when detected #then the valid abnormal terminal event passes", () => {
    const stdout = JSON.stringify({
      type: "message_end",
      message: {
        customType: "omo-senpi:wake",
        content: "Team member liveness: crash exited abnormally; last known state: error.",
        details: [{
          customType: "senpi-task.team-member-liveness",
          details: { memberName: "crash", lastKnownState: "error" },
        }],
      },
    })

    expect(hasCrashLivenessEvent(stdout)).toBe(true)
  })

  it("#given liveness-like details inside an unrelated event #when detected #then the gate rejects the false positive", () => {
    const stdout = JSON.stringify({
      type: "tool_execution_end",
      message: {
        role: "assistant",
        customType: "note",
        details: [{
          customType: "senpi-task.team-member-liveness",
          details: { memberName: "crash", lastKnownState: "error" },
        }],
      },
    })

    expect(hasCrashLivenessEvent(stdout)).toBe(false)
  })

  it("#given only matching prose without structured liveness details #when detected #then it cannot satisfy the gate", () => {
    const stdout = JSON.stringify({
      type: "message_end",
      message: { customType: "note", content: "Team member liveness: crash exited abnormally; last known state: lost." },
    })

    expect(hasCrashLivenessEvent(stdout)).toBe(false)
  })
})

describe("team e2e process cleanup", () => {
  it("#given a Windows npm senpi shim #when the spawn invocation is resolved #then Node launches the package CLI without cmd shell forwarding", () => {
    // given
    const shim = "C:\\Users\\qa\\AppData\\Roaming\\npm\\senpi"
    const cli = "C:\\Users\\qa\\AppData\\Roaming\\npm\\node_modules\\@code-yeongyu\\senpi\\dist\\cli.js"

    // when
    const invocation = runtime.resolveSenpiInvocation(shim, {
      platform: "win32",
      execPath: "C:\\Program Files\\nodejs\\node.exe",
      existsSync: (path: string) => path === cli,
    })

    // then
    expect(invocation).toEqual({
      command: "C:\\Program Files\\nodejs\\node.exe",
      prefixArgs: [cli],
    })
  })

  it("#given a native Windows senpi executable with mixed-case extension #when resolved #then the executable is preserved verbatim", () => {
    const executable = "C:\\Program Files\\Senpi\\senpi.EXE"

    const invocation = runtime.resolveSenpiInvocation(executable, {
      platform: "win32",
      execPath: "C:\\Program Files\\nodejs\\node.exe",
      existsSync: () => true,
    })

    expect(invocation).toEqual({ command: executable, prefixArgs: [] })
  })

  it("#given invalid root pids #when process-tree termination is requested #then every platform fails closed without side effects", () => {
    // given
    const invalidPids = [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, Number.MAX_SAFE_INTEGER + 1]
    const probes: number[] = []
    const windowsCalls: number[] = []
    const posixCalls: number[] = []

    // when / then
    for (const pid of invalidPids) {
      expect(runtime.terminateProcessTree(pid, {
        platform: "win32",
        isProcessAlive: (candidate: number) => {
          probes.push(candidate)
          return true
        },
        spawnSync: () => {
          windowsCalls.push(pid)
          return { status: 0, stdout: "SUCCESS", stderr: "" }
        },
      })).toEqual({
        kind: "failed",
        pid,
        platform: "win32",
        status: null,
        error: "pid must be a positive safe integer",
      })
      expect(runtime.terminateProcessTree(pid, {
        platform: "linux",
        isProcessAlive: (candidate: number) => {
          probes.push(candidate)
          return true
        },
        processKill: () => { posixCalls.push(pid) },
      })).toEqual({
        kind: "failed",
        pid,
        platform: "linux",
        status: null,
        error: "pid must be a positive safe integer",
      })
    }
    expect(probes).toEqual([])
    expect(windowsCalls).toEqual([])
    expect(posixCalls).toEqual([])
  })

  it("#given a live Windows QA root pid #when its process tree is terminated #then taskkill targets only that pid tree and returns structured evidence", () => {
    // given
    const calls: Array<{ command: string; args: readonly string[] }> = []
    const aliveReads = [true, false]

    // when
    const result = runtime.terminateProcessTree(4242, {
      platform: "win32",
      isProcessAlive: () => aliveReads.shift() ?? false,
      spawnSync: (command: string, args: readonly string[]) => {
        calls.push({ command, args })
        return { status: 0, stdout: "SUCCESS", stderr: "" }
      },
    })

    // then
    expect(calls).toEqual([{
      command: "taskkill.exe",
      args: ["/PID", "4242", "/T", "/F"],
    }])
    expect(result).toEqual({ kind: "terminated", pid: 4242, platform: "win32" })
  })

  it("#given a Windows QA root pid #when the legacy group-kill seam is called #then it delegates to exact tree termination", () => {
    // given
    const calls: number[] = []

    // when
    const killed = runtime.killProcessGroup(5151, {
      terminateProcessTree: (pid: number) => {
        calls.push(pid)
        return { kind: "terminated", pid, platform: "win32" }
      },
    })

    // then
    expect(killed).toBe(true)
    expect(calls).toEqual([5151])
  })

  it("#given Windows QA root pids #when cleanup runs #then it terminates each exact tree and counts failed trees as leaks", () => {
    // given
    const calls: number[] = []
    const outcomes = new Map([
      [100, { kind: "already-exited", pid: 100, platform: "win32" }],
      [200, { kind: "terminated", pid: 200, platform: "win32" }],
      [300, { kind: "failed", pid: 300, platform: "win32", status: 1, error: "still alive" }],
    ])

    // when
    const leaked = runtime.cleanupProcessGroups([100, 200, 300], {
      platform: "win32",
      terminateProcessTree: (pid: number) => {
        calls.push(pid)
        return outcomes.get(pid)
      },
    })

    // then
    expect(calls).toEqual([100, 200, 300])
    expect(leaked).toBe(1)
  })

  it("#given completed and live process groups #when cleanup runs #then it skips empty groups and kills concrete survivors", () => {
    // given
    const killed: number[] = []
    const reads = new Map<number, number>([[200, 0]])
    const listGroupPids = (groupId: number): readonly number[] => {
      if (groupId === 100) return []
      const count = reads.get(groupId) ?? 0
      reads.set(groupId, count + 1)
      return count === 0 ? [201, 202] : []
    }

    // when
    const leaked = runtime.cleanupProcessGroups([100, 200], {
      platform: "linux",
      listGroupPids,
      killProcess: (pid: number) => {
        killed.push(pid)
        return true
      },
    })

    // then
    expect(killed).toEqual([201, 202])
    expect(leaked).toBe(0)
  })
})
