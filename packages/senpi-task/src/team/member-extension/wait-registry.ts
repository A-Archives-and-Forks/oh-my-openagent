import type { Message } from "@oh-my-opencode/team-core/types"

export type MemberWaitFilter = {
  readonly from?: string
}

export type MemberWaitRegistration = {
  readonly promise: Promise<Message>
  cancel(reason?: unknown): boolean
}

export type MemberWaitClaim = {
  readonly message: Message
  isActive(): boolean
  resolve(): boolean
  abandon(): boolean
}

type WaitState = "waiting" | "claimed" | "settled" | "cancelled"

type WaitEntry = {
  readonly filter: MemberWaitFilter
  readonly resolvePromise: (message: Message) => void
  readonly rejectPromise: (reason: unknown) => void
  state: WaitState
}

// Temporary member-local wait primitive. The member wait tool is removed with the injection protocol;
// keeping it here avoids coupling the lead mailbox path to a member-only transitional mechanism.
export class MemberWaitRegistry {
  readonly #entries: WaitEntry[] = []

  get size(): number {
    return this.#entries.filter((entry) => entry.state === "waiting" || entry.state === "claimed").length
  }

  register(filter: MemberWaitFilter = {}): MemberWaitRegistration {
    let resolvePromise: (message: Message) => void = () => undefined
    let rejectPromise: (reason: unknown) => void = () => undefined
    const promise = new Promise<Message>((resolve, reject) => {
      resolvePromise = resolve
      rejectPromise = reject
    })
    const entry: WaitEntry = { filter, resolvePromise, rejectPromise, state: "waiting" }
    this.#entries.push(entry)

    return {
      promise,
      cancel: (reason?: unknown) => this.#cancel(entry, reason),
    }
  }

  takeMatch(message: Message): MemberWaitClaim | undefined {
    const entry = this.#entries.find((candidate) => (
      candidate.state === "waiting"
      && (candidate.filter.from === undefined || candidate.filter.from === message.from)
    ))
    if (entry === undefined) return undefined
    entry.state = "claimed"

    return {
      message,
      isActive: () => entry.state === "claimed",
      resolve: () => this.#resolve(entry, message),
      abandon: () => this.#abandon(entry),
    }
  }

  cancelAll(reason: unknown): void {
    for (const entry of [...this.#entries]) {
      if (entry.state !== "waiting" && entry.state !== "claimed") continue
      entry.state = "cancelled"
      this.#remove(entry)
      entry.rejectPromise(reason)
    }
  }

  #resolve(entry: WaitEntry, message: Message): boolean {
    if (entry.state !== "claimed") return false
    entry.state = "settled"
    this.#remove(entry)
    entry.resolvePromise(message)
    return true
  }

  #abandon(entry: WaitEntry): boolean {
    if (entry.state !== "claimed") return false
    entry.state = "waiting"
    return true
  }

  #cancel(entry: WaitEntry, reason: unknown): boolean {
    if (entry.state !== "waiting" && entry.state !== "claimed") return false
    entry.state = "cancelled"
    this.#remove(entry)
    if (reason !== undefined) entry.rejectPromise(reason)
    return true
  }

  #remove(entry: WaitEntry): void {
    const index = this.#entries.indexOf(entry)
    if (index >= 0) this.#entries.splice(index, 1)
  }
}

export function normalizeMemberWaitFrom(from: string | undefined): string | undefined {
  const trimmed = from?.trim()
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed
}
