// EINTR-resilient filesystem boundary for the memory stack.
//
// The bun-compiled engine surfaces raw EINTR from fs syscalls on macOS under signal load
// (child reaping in the multi-session shared host), which broke live turns: the notice-lock
// candidate open in before_agent_start, the per-tool-call guard scandir, and reflection
// state writes. POSIX defines EINTR as "interrupted before the operation completed", so
// whole-call retry is the correct recovery for every wrapped call except close(2), whose
// descriptor state is unspecified after interruption; close maps EINTR to success, matching
// libuv. Memory-stack code imports fs ONLY through this module (no-direct-node-fs tests).

import * as fsSync from "node:fs"
import * as fsp from "node:fs/promises"

export const EINTR_RETRY_CAP = 128

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !("code" in error)) return undefined
  return typeof error.code === "string" ? error.code : undefined
}

export async function retryOnEintr<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      if (errorCode(error) !== "EINTR" || attempt >= EINTR_RETRY_CAP) throw error
    }
  }
}

export function retryOnEintrSync<T>(operation: () => T): T {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return operation()
    } catch (error) {
      if (errorCode(error) !== "EINTR" || attempt >= EINTR_RETRY_CAP) throw error
    }
  }
}

type UnknownFunction = (...args: readonly unknown[]) => unknown

function isFunction(value: unknown): value is UnknownFunction {
  return typeof value === "function"
}

function withAsyncRetry(operation: UnknownFunction): UnknownFunction {
  return (...args) => retryOnEintr(async () => operation(...args))
}

function withSyncRetry(operation: UnknownFunction): UnknownFunction {
  return (...args) => retryOnEintrSync(() => operation(...args))
}

function resilientNamespace<M extends object>(
  namespace: M,
  wrapFunction: (operation: UnknownFunction) => UnknownFunction,
): M {
  const cache = new Map<PropertyKey, unknown>()
  return new Proxy(namespace, {
    get(target, property) {
      if (cache.has(property)) return cache.get(property)
      const value: unknown = Reflect.get(target, property)
      if (!isFunction(value)) return value
      const wrapped = wrapFunction(value)
      const native: unknown = Reflect.get(value, "native")
      if (isFunction(native)) Object.assign(wrapped, { native: wrapFunction(native) })
      cache.set(property, wrapped)
      return wrapped
    },
  })
}

export function wrapFileHandle<H extends object>(handle: H): H {
  return new Proxy(handle, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property)
      if (!isFunction(value)) return value
      const invoke = (args: readonly unknown[]): unknown => Reflect.apply(value, target, [...args])
      if (property === "close") {
        return (...args: readonly unknown[]) => {
          const result = invoke(args)
          if (!(result instanceof Promise)) return result
          return result.catch((error: unknown) => {
            if (errorCode(error) === "EINTR") return undefined
            throw error
          })
        }
      }
      return (...args: readonly unknown[]) => {
        const result = invoke(args)
        if (!(result instanceof Promise)) return result
        return result.catch((error: unknown) => {
          if (errorCode(error) !== "EINTR") throw error
          return retryOnEintr(async () => invoke(args))
        })
      }
    },
  })
}

const promises = resilientNamespace(fsp, withAsyncRetry)
const sync = resilientNamespace(fsSync, withSyncRetry)

export const {
  access,
  appendFile,
  chmod,
  cp,
  link,
  lstat,
  mkdir,
  mkdtemp,
  copyFile,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} = promises

export const {
  accessSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} = sync

export const { constants, watch } = fsSync

export const open: typeof fsp.open = async (...args) =>
  wrapFileHandle(await retryOnEintr(() => fsp.open(...args)))

// Node parity: existsSync never throws, but unlike node's, transient EINTR is retried
// instead of being misread as "missing".
export function existsSync(path: fsSync.PathLike): boolean {
  try {
    retryOnEintrSync(() => fsSync.statSync(path))
    return true
  } catch {
    return false
  }
}

export type { Dirent, FSWatcher, PathLike, Stats } from "node:fs"
export type { FileHandle } from "node:fs/promises"
