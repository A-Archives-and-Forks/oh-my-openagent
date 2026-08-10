import { createNodeGitExec, GitMemoryRepo, type MemoryIdentity, type ReflectionWorktree } from "@oh-my-opencode/memory-core"

export interface ReservationRunLedger {
  readonly version: 1
  readonly runId: string
  readonly kind: "reflection" | "dream"
  readonly trigger: "step-count" | "compaction" | "manual" | "dream"
  readonly origin?: "manual" | "idle" | "shutdown"
  readonly pid?: number
  readonly processStart?: string | null
  readonly childPid?: number
  readonly childProcessStart?: string | null
  readonly startedAt: string
  readonly hardDeadlineAt: number
  readonly terminationGraceMs: number
  readonly deadlineAt: number
  readonly mergePolicy: "auto" | "integration"
  readonly targetDoc?: string
  readonly worktreeDir: string
  readonly worktreeBranch: string
  readonly baseSha: string
  readonly gitFilePath: string
  readonly gitFileSnapshot: string
  readonly commonConfigPath: string
  readonly commonConfigSnapshot: string | null
}

export function parseReservationRunLedger(value: unknown): ReservationRunLedger {
  if (!isRecord(value)) throw new Error("Invalid reservation run ledger")
  const trigger = value.trigger
  const kind = value.kind
  if (value.version !== 1 || typeof value.runId !== "string") throw new Error("Invalid reservation run ledger identity")
  if (kind !== "reflection" && kind !== "dream") throw new Error("Invalid reservation run kind")
  if (trigger !== "step-count" && trigger !== "compaction" && trigger !== "manual" && trigger !== "dream") {
    throw new Error("Invalid reservation run trigger")
  }
  if ((kind === "dream") !== (trigger === "dream")) throw new Error("Reservation run kind and trigger disagree")
  if (trigger === "dream" && value.origin !== "manual" && value.origin !== "idle" && value.origin !== "shutdown") {
    throw new Error("Dream run origin is required")
  }
  const requiredStrings = ["startedAt", "worktreeDir", "worktreeBranch", "baseSha", "gitFilePath", "gitFileSnapshot", "commonConfigPath"] as const
  if (requiredStrings.some((field) => typeof value[field] !== "string")) throw new Error("Invalid reservation run paths")
  const requiredNumbers = ["hardDeadlineAt", "terminationGraceMs", "deadlineAt"] as const
  if (requiredNumbers.some((field) => typeof value[field] !== "number" || !Number.isFinite(value[field]))) {
    throw new Error("Invalid reservation run deadline")
  }
  const hardDeadlineAt = Number(value.hardDeadlineAt)
  const terminationGraceMs = Number(value.terminationGraceMs)
  if (Number(value.deadlineAt) !== hardDeadlineAt + terminationGraceMs) throw new Error("Reservation run deadline mismatch")
  if (value.mergePolicy !== "auto" && value.mergePolicy !== "integration") throw new Error("Invalid reservation merge policy")
  if (value.targetDoc !== undefined && (kind !== "dream" || typeof value.targetDoc !== "string")) {
    throw new Error("Invalid dream target document")
  }
  if (!optionalPid(value.pid) || !optionalIdentity(value.processStart) || !optionalPid(value.childPid) || !optionalIdentity(value.childProcessStart)) {
    throw new Error("Invalid reservation process identity")
  }
  if (value.commonConfigSnapshot !== null && typeof value.commonConfigSnapshot !== "string") {
    throw new Error("Invalid common config snapshot")
  }
  return value as unknown as ReservationRunLedger
}

export function worktreeFromLedger(identity: MemoryIdentity, ledger: ReservationRunLedger): ReflectionWorktree {
  return {
    parent: new GitMemoryRepo({ dir: identity.paths.repo, agentId: identity.id }),
    dir: ledger.worktreeDir,
    branch: ledger.worktreeBranch,
    baseSha: ledger.baseSha,
    gitFilePath: ledger.gitFilePath,
    gitFileSnapshot: ledger.gitFileSnapshot,
    commonConfigPath: ledger.commonConfigPath,
    commonConfigSnapshot: ledger.commonConfigSnapshot,
    exec: createNodeGitExec(),
  }
}

function optionalPid(value: unknown): boolean {
  return value === undefined || (Number.isInteger(value) && Number(value) > 0)
}

function optionalIdentity(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
