import { mkdir, rm } from "node:fs/promises"
import { dirname } from "node:path"
import { IsolationUnavailableError, type IsolationBackend, type IsolationContext } from "../backend"
import { markStarted } from "../backend-marker"
import { exists } from "../git/command"
import { checked, existingParent, runtime, type BackendRuntime } from "./runtime"

export class BtrfsBackend implements IsolationBackend {
  readonly kind = "btrfs" as const
  readonly clonesTree = true
  constructor(private readonly io: BackendRuntime = runtime) {}
  async probe(lower: string, ctx?: IsolationContext) {
    if (this.io.platform !== "linux" || !this.io.which("btrfs")) return { available: false, reason: "btrfs requires Linux and btrfs on PATH" }
    if (ctx && (ctx.crossDevice || await this.io.device(lower) !== await this.io.device(await existingParent(ctx.baseDir)))) return { available: false, reason: "btrfs requires the same device" }
    const result = await this.io.run(["btrfs", "subvolume", "show", lower])
    if (!result.code) return { available: true }
    if (/not a btrfs|not a subvolume|cannot find|no such|unknown subvolume|not a directory/i.test(result.stderr)) {
      return { available: false, reason: result.stderr }
    }
    // Unprivileged users cannot search the parent subvolume's B-tree, so show
    // reports EPERM even for a subvolume they may snapshot. Like upstream's
    // CLI-presence probe, treat it as inconclusive: attempting the snapshot in
    // start decides, and its classifier turns a genuine refusal unavailable.
    if (/operation not permitted|permission denied|could not search b-tree/i.test(result.stderr)) {
      return { available: true }
    }
    // An I/O or similar operational failure says nothing about btrfs capability.
    throw new Error(`btrfs subvolume show ${lower} failed (${result.code}): ${result.stderr}`)
  }
  async start(lower: string, merged: string, ctx: IsolationContext) {
    await mkdir(dirname(merged), { recursive: true })
    if (ctx.crossDevice) throw new IsolationUnavailableError("btrfs requires the same device")
    const probe = await this.probe(lower)
    if (!probe.available) throw new IsolationUnavailableError(probe.reason)
    const result = await this.io.run(["btrfs", "subvolume", "snapshot", lower, merged])
    if (result.code) {
      if (/not a subvolume|not a btrfs|operation not permitted|permission denied|operation not supported|cross-device/i.test(result.stderr)) throw new IsolationUnavailableError(result.stderr)
      throw new Error(`btrfs snapshot failed: ${result.stderr}`)
    }
    await markStarted(ctx.baseDir, this.kind)
  }
  async stop(merged: string) {
    if (!await exists(merged)) return
    await checked(this.io, ["btrfs", "subvolume", "delete", merged])
    await rm(merged, { recursive: true, force: true })
  }
}
