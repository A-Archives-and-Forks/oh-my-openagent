import { randomUUID } from "node:crypto"
import {
  closeSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"

import { getPidLiveness } from "@oh-my-opencode/memory-core"

import type { RunLivenessSeams } from "./run-liveness"

export type RunTerminalClaimKind = "publish" | "abandon"

export interface RunTerminalClaim {
  readonly version: 1
  readonly kind: RunTerminalClaimKind
  readonly runId: string
  readonly attempt: number
  readonly claimantPid: number
}

export function runTerminalClaimPath(runDir: string): string {
  return join(runDir, "terminal-claim.json")
}

export function claimRunTerminal(
  runDir: string,
  identity: { readonly runId: string; readonly attempt: number },
  kind: RunTerminalClaimKind,
  seams: RunLivenessSeams = {},
  claimantPid = process.pid,
): RunTerminalClaim {
  const path = runTerminalClaimPath(runDir)
  const requested: RunTerminalClaim = {
    version: 1,
    kind,
    runId: identity.runId,
    attempt: identity.attempt,
    claimantPid,
  }
  let discarded = 0
  for (;;) {
    if (createExclusiveClaim(path, requested)) return requested
    const existing = readClaimIfValid(path)
    if (existing === undefined) {
      // A claim only becomes visible complete, so an unreadable one authorized
      // nothing and is discarded rather than stranding the run forever.
      if (discarded > 0) throw new TypeError("Invalid run terminal claim")
      discarded += 1
      removeClaim(path)
      continue
    }
    if (runTerminalClaimMatches(existing, identity, kind)) return existing
    if (existing.kind !== "publish" || !claimantIsConfirmedDead(existing, seams)) return existing
    removeClaim(path)
  }
}

export function readRunTerminalClaim(runDir: string): RunTerminalClaim {
  return parseRunTerminalClaim(JSON.parse(readFileSync(runTerminalClaimPath(runDir), "utf8")))
}

export function runTerminalClaimMatches(
  claim: RunTerminalClaim,
  identity: { readonly runId: string; readonly attempt: number },
  kind?: RunTerminalClaimKind,
): boolean {
  return claim.runId === identity.runId
    && claim.attempt === identity.attempt
    && (kind === undefined || claim.kind === kind)
}

function createExclusiveClaim(path: string, claim: RunTerminalClaim): boolean {
  const candidate = `${path}.${process.pid}.${randomUUID()}.candidate`
  writeDurableClaim(candidate, claim)
  try {
    linkSync(candidate, path)
  } catch (error) {
    if (errorCode(error) === "EEXIST") return false
    throw error
  } finally {
    removeClaim(candidate)
  }
  syncDirectory(dirname(path))
  return true
}

function writeDurableClaim(path: string, claim: RunTerminalClaim): void {
  const file = openSync(path, "wx", 0o600)
  try {
    writeFileSync(file, `${JSON.stringify(claim, null, 2)}\n`, "utf8")
    fsyncSync(file)
  } finally {
    closeSync(file)
  }
}

function readClaimIfValid(path: string): RunTerminalClaim | undefined {
  try {
    return parseRunTerminalClaim(JSON.parse(readFileSync(path, "utf8")))
  } catch {
    return undefined
  }
}

function removeClaim(path: string): void {
  try {
    unlinkSync(path)
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error
  }
}

function claimantIsConfirmedDead(claim: RunTerminalClaim, seams: RunLivenessSeams): boolean {
  return (seams.getPidLiveness ?? getPidLiveness)(claim.claimantPid) === "dead"
}

function parseRunTerminalClaim(value: unknown): RunTerminalClaim {
  if (!isRecord(value)
    || value.version !== 1
    || (value.kind !== "publish" && value.kind !== "abandon")
    || typeof value.runId !== "string"
    || !Number.isInteger(value.attempt)
    || !Number.isInteger(value.claimantPid)
    || Number(value.claimantPid) <= 0) {
    throw new TypeError("Invalid run terminal claim")
  }
  return {
    version: 1,
    kind: value.kind,
    runId: value.runId,
    attempt: Number(value.attempt),
    claimantPid: Number(value.claimantPid),
  }
}

function syncDirectory(path: string): void {
  let directory: number
  try {
    directory = openSync(path, "r")
  } catch (error) {
    if (process.platform === "win32" && ["EISDIR", "EPERM"].includes(errorCode(error) ?? "")) return
    throw error
  }
  try {
    fsyncSync(directory)
  } finally {
    closeSync(directory)
  }
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error ? String(error.code) : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
