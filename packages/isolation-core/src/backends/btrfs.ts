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
    return { available: result.code === 0, reason: result.code ? result.stderr : undefined }
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
