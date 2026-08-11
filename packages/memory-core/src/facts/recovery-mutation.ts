import type { GitIndexIdentity, GitMemoryRepo, GitPathState, GitWorktreeIdentity } from "../git"
import type { FactsApplyRecovery } from "./mutation-plan"
import type { FactsOwnedState } from "./recovery-ownership"
import { sameIdentity } from "./recovery-ownership"

export class FactsOwnershipLostError extends Error {
  override readonly name = "FactsOwnershipLostError"
}

type MutationRecord =
  | { readonly path: string; readonly surface: "index"; readonly before: GitIndexIdentity | null; readonly after: GitIndexIdentity | null }
  | { readonly path: string; readonly surface: "worktree"; readonly before: GitWorktreeIdentity; readonly after: GitWorktreeIdentity }

export class FactsMutationTransaction {
  private readonly mutations: MutationRecord[] = []

  constructor(
    private readonly repo: GitMemoryRepo,
    private readonly recovery: FactsApplyRecovery,
    private readonly initial: FactsOwnedState,
  ) {}

  async restorePreState(): Promise<void> {
    for (const entry of this.recovery.paths) {
      await this.compareAndSetIndex(entry.path, this.initialState(entry.path).index, entry.pre.index)
    }
    for (const entry of this.recovery.paths) {
      await this.compareAndSetWorktree(entry.path, this.initialState(entry.path).worktree, entry.pre.worktree)
    }
  }

  async applyPostState(): Promise<void> {
    for (const entry of this.recovery.paths) await this.compareAndSetIndex(entry.path, entry.pre.index, entry.post.index)
    for (const entry of this.recovery.paths) {
      await this.compareAndSetWorktree(entry.path, entry.pre.worktree, entry.post.worktree)
    }
  }

  async rollback(): Promise<void> {
    for (const mutation of [...this.mutations].reverse()) {
      const current = await this.repo.pathState.capture(mutation.path)
      if (mutation.surface === "index" && sameIdentity(current.index, mutation.after)) {
        await this.writeIndex(mutation.path, mutation.before)
      } else if (mutation.surface === "worktree" && sameIdentity(current.worktree, mutation.after)) {
        await this.writeWorktree(mutation.path, mutation.before)
      }
    }
  }

  private initialState(path: string): GitPathState {
    const state = this.initial.get(path)
    if (state === undefined) throw new FactsOwnershipLostError(`Missing initial facts state: ${path}`)
    return state
  }

  private async compareAndSetIndex(
    path: string,
    expected: GitIndexIdentity | null,
    next: GitIndexIdentity | null,
  ): Promise<void> {
    const current = (await this.repo.pathState.capture(path)).index
    if (!sameIdentity(current, expected)) throw new FactsOwnershipLostError(`Facts ownership changed: ${path}:index`)
    if (sameIdentity(current, next)) return
    await this.writeIndex(path, next)
    this.mutations.push({ path, surface: "index", before: current, after: next })
  }

  private async compareAndSetWorktree(
    path: string,
    expected: GitWorktreeIdentity,
    next: GitWorktreeIdentity,
  ): Promise<void> {
    const current = (await this.repo.pathState.capture(path)).worktree
    if (!sameIdentity(current, expected)) throw new FactsOwnershipLostError(`Facts ownership changed: ${path}:worktree`)
    if (sameIdentity(current, next)) return
    await this.writeWorktree(path, next)
    this.mutations.push({ path, surface: "worktree", before: current, after: next })
  }

  private async writeIndex(path: string, identity: GitIndexIdentity | null): Promise<void> {
    if (identity === null) await this.repo.pathState.removeIndex(path)
    else await this.repo.pathState.setIndex(path, identity)
  }

  private async writeWorktree(path: string, identity: GitWorktreeIdentity): Promise<void> {
    if (identity.kind === "missing") await this.repo.pathState.removeWorktree(path)
    else await this.repo.pathState.writeWorktree(path, identity)
  }
}
