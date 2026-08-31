import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const packageRoot = dirname(fileURLToPath(import.meta.url))
const require = createRequire(join(packageRoot, "package.json"))
let senpiRoot
try {
  const searchPaths = require.resolve.paths("@code-yeongyu/senpi") ?? []
  for (const searchPath of searchPaths) {
    const candidate = join(searchPath, "@code-yeongyu", "senpi")
    if (existsSync(join(candidate, "package.json"))) {
      senpiRoot = candidate
      break
    }
  }
  if (senpiRoot === undefined) throw new Error("package root not found in module graph")
} catch (error) {
  throw new Error("omo-ai: unable to resolve the installed @code-yeongyu/senpi package", { cause: error })
}

const transforms = {
  "dist/core/extensions/builtin/claude-sdk-oauth/session-registry-pump.js": [
    [
      'throw new SessionTurnAttributionError("Claude SDK OAuth result arrived before replay claim");',
      'throw new SessionTurnAttributionError(describeUnclaimedResult(message));',
    ],
    [
      'function handleMessage(registry, entry, message) {',
      'function describeUnclaimedResult(message) {\n    const errors = Array.isArray(message.errors) ? message.errors : [];\n    const detail = errors.length > 0 ? String(errors[0]) : typeof message.result === "string" ? message.result : typeof message.error === "string" ? message.error : typeof message.terminal_reason === "string" ? message.terminal_reason : undefined;\n    return `Claude SDK OAuth query result${typeof message.subtype === "string" ? ` (${message.subtype})` : ""}${detail ? `: ${detail}` : ""}`;\n}\nfunction handleMessage(registry, entry, message) {',
    ],
  ],
  "dist/core/extensions/builtin/hooks/trust-storage.js": [
    [
      'import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";',
      'import { randomUUID } from "node:crypto";\nimport { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";',
    ],
    [
      'return withHookStateFileLock(statePathForScope(scope, this.globalStatePath, this.projectStatePath), (path) => readHookTrustStateJson(existsSync(path) ? readFileSync(path, "utf-8") : undefined));',
      'const path = statePathForScope(scope, this.globalStatePath, this.projectStatePath);\n        const input = existsSync(path) ? readFileSync(path, "utf-8") : undefined;\n        if (isCompleteHookStateSnapshot(input)) {\n            return readHookTrustStateJson(input);\n        }\n        if (existsSync(`${path}.lock`)) {\n            return withHookStateFileLock(path, (lockedPath) => readHookTrustStateJson(existsSync(lockedPath) ? readFileSync(lockedPath, "utf-8") : undefined));\n        }\n        return readHookTrustStateJson(existsSync(path) ? readFileSync(path, "utf-8") : undefined);',
    ],
    [
      'const current = readHookTrustStateJson(existsSync(path) ? readFileSync(path, "utf-8") : undefined);',
      'const stateExists = existsSync(path);\n            const current = readHookTrustStateJson(stateExists ? readFileSync(path, "utf-8") : undefined);\n            const mode = stateExists ? statSync(path).mode & 0o777 : 0o600;',
    ],
    [
      'writeFileSync(path, serializeHookTrustState(next), "utf-8");',
      'const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;\n            try {\n                writeFileSync(tempPath, serializeHookTrustState(next), { encoding: "utf-8", mode });\n                chmodSync(tempPath, mode);\n                renameSync(tempPath, path);\n            }\n            catch (publicationError) {\n                try {\n                    rmSync(tempPath, { force: true });\n                }\n                catch (cleanupError) {\n                    throw new AggregateError([publicationError, cleanupError], "Failed to publish and clean up hook trust state snapshot");\n                }\n                throw publicationError;\n            }',
    ],
    [
      'function acquireHookStateLockSync(path) {',
      'function isCompleteHookStateSnapshot(input) {\n    if (input === undefined || input.trim() === "") return false;\n    try {\n        const parsed = JSON.parse(input);\n        return isRecord(parsed) && parsed.version === 1 && isRecord(parsed.hooks);\n    } catch {\n        return false;\n    }\n}\nfunction acquireHookStateLockSync(path) {',
    ],
  ],
}

for (const [relative, replacements] of Object.entries(transforms)) {
  const path = join(senpiRoot, relative)
  if (!existsSync(path)) throw new Error(`omo-ai: installed Senpi target is missing: ${relative}`)
  let source = readFileSync(path, "utf8")
  const alreadyTransformed = relative.endsWith("trust-storage.js")
    ? source.includes("isCompleteHookStateSnapshot")
    : source.includes("describeUnclaimedResult")
  if (alreadyTransformed) continue
  for (const [from, to] of replacements) {
    if (source.includes(to)) continue
    if (!source.includes(from)) throw new Error(`omo-ai: unsupported Senpi ${relative}`)
    source = source.replace(from, to)
  }
  writeFileSync(path, source)
}
