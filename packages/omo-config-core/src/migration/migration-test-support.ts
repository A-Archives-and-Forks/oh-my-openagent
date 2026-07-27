import { isPlainObject } from "../internal/plain-object"
import { parseJsoncSafe } from "../internal/jsonc-parse"
import type { MigrationFileSystem } from "./types"

function fileError(code: string, message: string): Error {
  const error = new Error(message)
  Object.defineProperty(error, "code", { value: code })
  return error
}

export class MemoryMigrationFileSystem implements MigrationFileSystem {
  readonly directories = new Set<string>()
  readonly files = new Map<string, string>()
  readonly operations: string[] = []

  copyFileSync(source: string, destination: string): void {
    this.files.set(destination, this.readFileSync(source, "utf-8"))
  }

  existsSync(path: string): boolean {
    return this.files.has(path) || this.directories.has(path)
  }

  lstatSync(_path: string): { readonly isSymbolicLink: () => boolean } {
    return { isSymbolicLink: () => false }
  }

  mkdirSync(path: string, _options: { readonly recursive: true }): string | undefined {
    this.directories.add(path)
    this.operations.push(`mkdir:${path}`)
    return undefined
  }

  readFileSync(path: string, _encoding: "utf-8"): string {
    const content = this.files.get(path)
    if (content === undefined) throw fileError("ENOENT", `Missing ${path}`)
    return content
  }

  readdirSync(path: string): string[] {
    const prefix = path.endsWith("/") ? path : `${path}/`
    return [...this.files.keys()]
      .filter((file) => file.startsWith(prefix))
      .map((file) => file.slice(prefix.length))
      .filter((file) => !file.includes("/"))
  }

  removeIfContentsMatchSync(path: string, expected: string): boolean {
    if (this.files.get(path) !== expected) return false
    this.files.delete(path)
    this.operations.push(`remove:${path}`)
    return true
  }

  renameSync(oldPath: string, newPath: string): void {
    const content = this.readFileSync(oldPath, "utf-8")
    this.files.set(newPath, content)
    this.files.delete(oldPath)
    this.operations.push(`rename:${oldPath}:${newPath}`)
  }

  replaceIfContentsMatchSync(path: string, expected: string, content: string): boolean {
    if (this.files.get(path) !== expected) return false
    this.files.set(path, content)
    this.operations.push(`replace:${path}`)
    return true
  }

  unlinkSync(path: string): void {
    if (!this.files.delete(path)) throw fileError("ENOENT", `Missing ${path}`)
    this.operations.push(`unlink:${path}`)
  }

  writeFileExclusiveSync(path: string, content: string): void {
    if (this.files.has(path)) throw fileError("EEXIST", `Already exists ${path}`)
    this.files.set(path, content)
    this.operations.push(`exclusive:${path}`)
  }

  writeFileSync(path: string, content: string, _encoding: "utf-8"): void {
    this.files.set(path, content)
    this.operations.push(`write:${path}`)
  }
}

export const migrationFixture = {
  env: { HOME: "/home/alice" },
  sourcePath: "/legacy/config.jsonc",
  targetPath: "/home/alice/.omo/omo.jsonc",
}

export function parseFile(fileSystem: MemoryMigrationFileSystem, path: string): Record<string, unknown> {
  const parsed = parseJsoncSafe<unknown>(fileSystem.readFileSync(path, "utf-8"))
  if (parsed.errors.length > 0 || !isPlainObject(parsed.data)) throw new Error(`Invalid JSONC at ${path}`)
  return parsed.data
}
