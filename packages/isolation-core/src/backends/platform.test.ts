import { expect, test } from "bun:test"
import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fixture } from "../test-fixture"
import { BACKEND_FILE, IsolationUnavailableError } from "../backend"
import { BtrfsBackend } from "./btrfs"
import { ZfsBackend } from "./zfs"
import { OverlayfsBackend } from "./overlayfs"
import { ReflinkBackend } from "./reflink"
import { BlockCloneBackend, duplicateExtents, type WindowsCloneApi } from "./block-clone"
import { runtime, type BackendRuntime } from "./runtime"

function fake(overrides: Partial<BackendRuntime> = {}) {
  const calls: string[][] = []
  const io: BackendRuntime = { ...runtime, platform: "linux", which: () => true,
    run: async (argv) => { calls.push(argv); return { code: 0, stdout: "", stderr: "" } },
    device: async () => 1, accessible: async () => true,
    mounted: async () => false, waitMounted: async () => {}, ...overrides }
  return { io, calls }
}
async function paths() {
  const f = await fixture(), baseDir = join(f.root, "creating")
  await mkdir(baseDir)
  return { ...f, baseDir, merged: join(baseDir, "m"), ctx: { id: "test", baseDir, crossDevice: false } }
}

test("btrfs checks binary, subvolume and device then snapshots/deletes with argv", async () => {
  const f = await paths(), { io, calls } = fake()
  const backend = new BtrfsBackend(io)
  expect((await backend.probe(f.repoRoot)).available).toBe(true)
  await backend.start(f.repoRoot, f.merged, f.ctx)
  await mkdir(f.merged)
  await backend.stop(f.merged)
  expect(calls).toEqual([
    ["btrfs", "subvolume", "show", f.repoRoot],
    ["btrfs", "subvolume", "show", f.repoRoot],
    ["btrfs", "subvolume", "snapshot", f.repoRoot, f.merged],
    ["btrfs", "subvolume", "delete", f.merged],
  ])
  expect(JSON.parse(await readFile(join(f.baseDir, BACKEND_FILE), "utf8"))).toEqual({ backend: "btrfs", started_at: expect.any(String) })
  for (const override of [{ platform: "darwin" as const }, { which: () => false }, { run: async () => ({ code: 1, stdout: "", stderr: "not a subvolume" }) }]) {
    expect((await new BtrfsBackend(fake(override).io).probe(f.repoRoot)).available).toBe(false)
  }
  await expect(backend.start(f.repoRoot, f.merged, { ...f.ctx, crossDevice: true })).rejects.toBeInstanceOf(IsolationUnavailableError)
  await expect(new BtrfsBackend(fake({ device: async (p) => p === f.repoRoot ? 1 : 2 }).io).start(f.repoRoot, f.merged, f.ctx)).rejects.toBeInstanceOf(IsolationUnavailableError)
})

test("zfs dataset-root probe, snapshot/clone, relocation and restart-safe stop", async () => {
  const f = await paths(), calls: string[][] = []
  const { io } = fake({ run: async (argv) => {
    calls.push(argv)
    return { code: 0, stdout: argv[1] === "list" ? `pool/repo\t${f.repoRoot}\n` : "", stderr: "" }
  } })
  expect((await new ZfsBackend(io).probe(join(f.repoRoot, "subdir"))).available).toBe(false)
  expect((await new ZfsBackend(fake({ which: () => false }).io).probe(f.repoRoot)).available).toBe(false)
  const backend = new ZfsBackend(io)
  await backend.start(f.repoRoot, f.merged, f.ctx)
  await mkdir(f.merged)
  const final = join(f.root, "final")
  await backend.relocate(f.baseDir, final)
  await new ZfsBackend(io).stop(join(final, "m"))
  expect(calls.slice(-5)).toEqual([
    ["zfs", "snapshot", "pool/repo@omo-test"],
    ["zfs", "clone", "-o", `mountpoint=${f.merged}`, "pool/repo@omo-test", "pool/repo/omo-test"],
    ["zfs", "set", `mountpoint=${join(final, "m")}`, "pool/repo/omo-test"],
    ["zfs", "destroy", "-r", "pool/repo/omo-test"],
    ["zfs", "destroy", "pool/repo@omo-test"],
  ])
})

test("overlay relocates by unmount, parent rename, remount with new upper/work paths", async () => {
  const f = await paths(), { io, calls } = fake({ mounted: async () => true })
  const backend = new OverlayfsBackend(io)
  await backend.start(f.repoRoot, f.merged, f.ctx)
  const final = join(f.root, "final")
  await backend.relocate(f.baseDir, final)
  await backend.stop(join(final, "m"))
  expect(calls).toEqual([
    ["fuse-overlayfs", "-o", `lowerdir=${f.repoRoot},upperdir=${f.baseDir}/upper,workdir=${f.baseDir}/work`, f.merged],
    ["fusermount3", "-u", f.merged],
    ["fuse-overlayfs", "-o", `lowerdir=${f.repoRoot},upperdir=${final}/upper,workdir=${final}/work`, join(final, "m")],
    ["fusermount3", "-u", join(final, "m")],
  ])
  for (const override of [{ which: () => false }, { accessible: async () => false }, { platform: "darwin" as const }]) {
    expect((await new OverlayfsBackend(fake(override).io).probe(f.repoRoot)).available).toBe(false)
  }
})

test("overlay unmount failure retries three times and leaves source untouched", async () => {
  const f = await paths(), { io, calls } = fake({ mounted: async () => true,
    run: async (argv) => { calls.push(argv); return { code: argv[0] === "fusermount3" ? 1 : 0, stdout: "", stderr: "busy" } } })
  const backend = new OverlayfsBackend(io)
  await backend.start(f.repoRoot, f.merged, f.ctx)
  await writeFile(join(f.merged, "sentinel"), "untouched")
  await expect(backend.relocate(f.baseDir, join(f.root, "final"))).rejects.toThrow("busy")
  expect(calls.filter((argv) => argv[0] === "fusermount3")).toHaveLength(3)
  expect(await readFile(join(f.merged, "sentinel"), "utf8")).toBe("untouched")
  await expect(access(join(f.root, "final"))).rejects.toThrow()
})

test("reflink ffi unavailable selects cp argv and classifies only unsupported failures", async () => {
  const f = await paths(), { io, calls } = fake()
  const backend = new ReflinkBackend(io, async () => undefined)
  expect((await backend.probe(f.repoRoot)).available).toBe(true)
  await backend.start(f.repoRoot, f.merged, f.ctx)
  expect(calls.at(-1)).toEqual(["cp", "-a", "--reflink=always", f.repoRoot, f.merged])
  for (const stderr of ["failed to clone", "Operation not supported", "Invalid cross-device link", "permission denied"]) {
    const bad = new ReflinkBackend(fake({ run: async () => ({ code: 1, stdout: "", stderr }) }).io, async () => undefined)
    let failure: unknown
    try { await bad.start(f.repoRoot, f.merged, f.ctx) } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain(stderr)
    expect(failure instanceof IsolationUnavailableError).toBe(stderr !== "permission denied")
  }
})

test("reflink probe rejects EOPNOTSUPP and disables start", async () => {
  const f = await paths(), { io } = fake()
  const unsupported = new ReflinkBackend(io, async () => ({ ioctl: () => -1, errno: () => 95 }))
  expect((await unsupported.probe(f.repoRoot)).available).toBe(false)
  await writeFile(join(f.repoRoot, "data"), "source")
  await expect(unsupported.start(f.repoRoot, f.merged, f.ctx)).rejects.toBeInstanceOf(IsolationUnavailableError)
  await expect(access(f.merged)).rejects.toThrow()
})

test("ReFS probe rejects non-Windows, missing binary and wrong filesystem", async () => {
  const f = await paths()
  for (const overrides of [{}, { platform: "win32" as const, which: () => false }, { platform: "win32" as const }]) {
    expect((await new BlockCloneBackend(fake(overrides).io).probe(f.repoRoot)).available).toBe(false)
  }
})

test("ReFS duplicate extents uses aligned range, allocated EOF and closes native handles", async () => {
  const calls: unknown[][] = []
  const api: WindowsCloneApi = {
    open: (path, write) => { calls.push(["open", path, write]); return write ? 2 : 1 },
    resize: (handle, size) => { calls.push(["resize", handle, size]) },
    duplicate: (dst, src, bytes) => { calls.push(["ioctl", dst, src, 0x00098344, bytes]) },
    close: (handle) => { calls.push(["close", handle]) },
    clusterSize: () => 4096,
  }
  await duplicateExtents(api, "C:\\repo\\src", "C:\\out\\dst", 8192)
  expect(calls).toEqual([
    ["open", "\\\\?\\C:\\repo\\src", false], ["open", "\\\\?\\C:\\out\\dst", true],
    ["resize", 2, 8192], ["ioctl", 2, 1, 0x00098344, 8192], ["resize", 2, 8192], ["close", 2], ["close", 1],
  ])
})


test("zfs failed relocation restores the source parent and marker identity", async () => {
  const f = await paths(), calls: string[][] = []
  const { io } = fake({ run: async (argv) => {
    calls.push(argv)
    return { code: argv[1] === "set" ? 1 : 0, stdout: argv[1] === "list" ? `pool/repo\t${f.repoRoot}\n` : "", stderr: "mount busy" }
  } })
  const backend = new ZfsBackend(io)
  await backend.start(f.repoRoot, f.merged, f.ctx)
  await mkdir(f.merged)
  await writeFile(join(f.merged, "sentinel"), "untouched")
  const final = join(f.root, "final")
  await expect(backend.relocate(f.baseDir, final)).rejects.toThrow("mount busy")
  expect(await readFile(join(f.merged, "sentinel"), "utf8")).toBe("untouched")
  expect(JSON.parse(await readFile(join(f.baseDir, BACKEND_FILE), "utf8")).dataset).toBe("pool/repo/omo-test")
  await expect(access(final)).rejects.toThrow()
  expect(calls.at(-1)).toEqual(["zfs", "set", `mountpoint=${join(final, "m")}`, "pool/repo/omo-test"])
})

test("zfs clone failure leaves a snapshot marker that restart-safe stop reclaims", async () => {
  const f = await paths(), calls: string[][] = []
  const { io } = fake({ run: async (argv) => {
    calls.push(argv)
    return { code: argv[1] === "clone" ? 1 : 0, stdout: argv[1] === "list" ? `pool/repo\t${f.repoRoot}\n` : "", stderr: "clone failed" }
  } })
  await expect(new ZfsBackend(io).start(f.repoRoot, f.merged, f.ctx)).rejects.toThrow("clone failed")
  await new ZfsBackend(io).stop(f.merged)
  expect(calls.at(-1)).toEqual(["zfs", "destroy", "pool/repo@omo-test"])
  expect(calls.some((argv) => argv[1] === "destroy" && argv[2] === "-r")).toBe(false)
})

test("cp unsupported stderr with exit 2 remains a generic error", async () => {
  const f = await paths()
  const backend = new ReflinkBackend(fake({ run: async () => ({ code: 2, stdout: "", stderr: "failed to clone" }) }).io, async () => undefined)
  let failure: unknown
  try { await backend.start(f.repoRoot, f.merged, f.ctx) } catch (error) { failure = error }
  expect(failure).toBeInstanceOf(Error)
  expect(failure instanceof IsolationUnavailableError).toBe(false)
  expect((failure as Error).message).toContain("cp exited 2")
})


test("missing cp probe cannot leave the fallback tier enabled", async () => {
  const f = await paths(), { io, calls } = fake({ which: () => false })
  const backend = new ReflinkBackend(io, async () => undefined)
  expect((await backend.probe(f.repoRoot)).available).toBe(false)
  await expect(backend.start(f.repoRoot, f.merged, f.ctx)).rejects.toBeInstanceOf(IsolationUnavailableError)
  expect(calls).toEqual([])
})
