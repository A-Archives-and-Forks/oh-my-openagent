// Reading the lock protocol's process-start fingerprint by spawning `/bin/ps` forks a child on every
// lock check, and a long-lived shared RPC host never reaps those children: 9,386 zombie `ps` entries
// filled the macOS process table and every posix_spawn on the machine failed with EAGAIN (#8096,
// code-yeongyu/senpi#1507). libproc answers the same question in-process, so the fork stops existing.

const PROC_PIDTBSDINFO = 3
/** sizeof(struct proc_bsdinfo) on 64-bit darwin; a short read means the flavor was rejected. */
const PROC_BSDINFO_SIZE = 136
/** Byte offset of `pbi_start_tvsec` inside struct proc_bsdinfo. */
const START_TVSEC_OFFSET = 120

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const

type ProcPidInfo = (pid: number, flavor: number, arg: bigint, buffer: Uint8Array, size: number) => number

let procPidInfoLookup: Promise<ProcPidInfo | null> | null = null

async function openProcPidInfo(): Promise<ProcPidInfo | null> {
  if (process.platform !== "darwin") return null
  try {
    const { dlopen, FFIType } = await import("bun:ffi")
    const library = dlopen("/usr/lib/libSystem.B.dylib", {
      proc_pidinfo: {
        args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32],
        returns: FFIType.i32,
      },
    })
    return (pid, flavor, arg, buffer, size) => Number(library.symbols.proc_pidinfo(pid, flavor, arg, buffer, size))
  } catch {
    return null
  }
}

function loadProcPidInfo(): Promise<ProcPidInfo | null> {
  procPidInfoLookup ??= openProcPidInfo()
  return procPidInfoLookup
}

// `ps -o lstart=` renders C-locale abbreviations with a space-padded day. Identities are persisted in
// lock files and compared as strings, so this format must stay byte-identical to the `ps` output.
function formatLstart(startSeconds: number): string | null {
  const date = new Date(startSeconds * 1000)
  if (Number.isNaN(date.getTime())) return null
  const weekday = WEEKDAYS[date.getDay()]
  const month = MONTHS[date.getMonth()]
  if (weekday === undefined || month === undefined) return null
  const day = String(date.getDate()).padStart(2, " ")
  const hours = String(date.getHours()).padStart(2, "0")
  const minutes = String(date.getMinutes()).padStart(2, "0")
  const seconds = String(date.getSeconds()).padStart(2, "0")
  return `${weekday} ${month} ${day} ${hours}:${minutes}:${seconds} ${date.getFullYear()}`
}

/**
 * Start time of `pid` in `ps -o lstart=` form without spawning a process, or `null` when darwin
 * cannot answer it (dead pid, pid owned by another uid, libproc unavailable).
 */
export async function readDarwinProcessLstart(pid: number): Promise<string | null> {
  if (process.platform !== "darwin") return null
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  const procPidInfo = await loadProcPidInfo()
  if (procPidInfo === null) return null
  const buffer = new Uint8Array(PROC_BSDINFO_SIZE)
  let written = 0
  try {
    written = procPidInfo(pid, PROC_PIDTBSDINFO, 0n, buffer, PROC_BSDINFO_SIZE)
  } catch {
    return null
  }
  if (written !== PROC_BSDINFO_SIZE) return null
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const startSeconds = Number(view.getBigUint64(START_TVSEC_OFFSET, true))
  if (startSeconds <= 0) return null
  return formatLstart(startSeconds)
}
