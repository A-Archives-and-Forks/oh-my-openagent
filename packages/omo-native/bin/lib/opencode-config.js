import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { parseJsoncLite } from "./jsonc-lite.js"

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function mergeLayers(earlier, later) {
  return Object.fromEntries([...new Set([...Object.keys(earlier), ...Object.keys(later)])].map((key) => {
    if (!Object.hasOwn(later, key)) return [key, earlier[key]]
    const value = isRecord(earlier[key]) && isRecord(later[key])
      ? mergeLayers(earlier[key], later[key])
      : later[key]
    return [key, value]
  }))
}

export function readOpencodeConfigDir(home, env) {
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "opencode")
}

export function readOpencodeConfigFiles(configDir, names = ["config.json", "opencode.json", "opencode.jsonc"]) {
  const paths = []
  let value
  for (const name of names) {
    const path = join(configDir, name)
    if (!existsSync(path)) continue
    let parsed
    try {
      parsed = parseJsoncLite(readFileSync(path, "utf8"))
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      throw new Error(`Malformed OpenCode config: ${path}`)
    }
    if (!isRecord(parsed)) throw new Error(`OpenCode config must be an object: ${path}`)
    value = mergeLayers(value ?? {}, parsed)
    paths.push(path)
  }
  return { value, paths }
}

export function readOpencodeGlobalConfig(configDir) {
  return readOpencodeConfigFiles(configDir).value
}
