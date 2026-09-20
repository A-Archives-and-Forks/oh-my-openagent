import { load, YAMLException } from "js-yaml"
import { isDeepStrictEqual } from "node:util"
import { validateModelsConfig } from "../../node_modules/@code-yeongyu/senpi/dist/core/model-config-schema.js"
import {
  getServerEndpointValidationError,
  validateConfig as validateMcpConfig,
} from "../../node_modules/@code-yeongyu/senpi/dist/core/extensions/builtin/mcp/config-schema.js"

import {
  mergeWithoutClobber,
  OmoAgentDefSchema,
  OmoConfigLayerSchema,
  resolveOmoConfigPaths,
} from "@oh-my-opencode/omo-config-core"
type RecordValue = Record<string, unknown>
declare const __MIGRATION_PROVIDER_MAP__: { readonly providers: Readonly<Record<string, string>> }

export function nativeModelsDiagnostics(value: unknown): string[] {
  return [...validateModelsConfig.Errors(value)].map((issue) => issue.instancePath || "$")
}

export function assertNativeModelsConfig(value: unknown): void {
  const diagnostics = nativeModelsDiagnostics(value)
  if (diagnostics.length > 0) throw new Error(`Invalid models config fields: ${diagnostics.join(", ")}`)
}

export function assertNativeMcpConfig(value: unknown): void {
  if (!validateMcpConfig.Check(value)) {
    const issue = [...validateMcpConfig.Errors(value)][0]
    throw new Error(`Invalid MCP config field: ${issue?.instancePath || "$"}`)
  }
  const endpoint = getServerEndpointValidationError(value)
  if (endpoint !== undefined) throw new Error(`Invalid MCP config: ${endpoint}`)
}

export type ParsedAgentMarkdown = {
  readonly body: string
  readonly frontmatter: RecordValue
}

export type OmoConfigValidation = {
  readonly diagnostics: readonly string[]
  readonly value: RecordValue | undefined
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export class AgentFrontmatterError extends Error {}

function parseFrontmatter(value: string): RecordValue {
  let parsed: unknown
  try {
    parsed = load(value)
  } catch (error) {
    if (!(error instanceof YAMLException)) throw error
    throw new AgentFrontmatterError("Malformed agent frontmatter")
  }
  if (!isRecord(parsed)) throw new AgentFrontmatterError("Agent frontmatter must be an object")
  return parsed
}

export function parseAgentMarkdown(text: string): ParsedAgentMarkdown {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (match === null) return { frontmatter: {}, body: text.trim() }
  return { frontmatter: parseFrontmatter(match[1]), body: match[2].trim() }
}

export function selectUserOmoConfigPath(home: string): string {
  const paths = resolveOmoConfigPaths({ cwd: home, env: { HOME: home, USERPROFILE: home } })
  return paths[0].path
}

export function resolveProviderAlias(id: string): string {
  return __MIGRATION_PROVIDER_MAP__.providers[id] ?? id
}

function conflictPaths(existing: RecordValue, incoming: RecordValue, prefix: readonly string[]): string[] {
  return Object.entries(incoming).flatMap(([key, value]) => {
    const path = [...prefix, key]
    if (["__proto__", "constructor", "prototype"].includes(key)) return [`unsupported: ${path.join(".")}`]
    if (!Object.hasOwn(existing, key)) return []
    const kept = existing[key]
    if (isRecord(kept) && isRecord(value)) return conflictPaths(kept, value, path)
    return isDeepStrictEqual(kept, value) ? [] : [`skipped: ${path.join(".")}`]
  })
}

export function mergeOmoConfig(
  existing: RecordValue,
  additions: RecordValue,
): { readonly diagnostics: readonly string[]; readonly value: RecordValue } {
  const merged = mergeWithoutClobber(existing, additions)
  return { diagnostics: conflictPaths(existing, additions, []), value: merged.merged }
}

export function validateOmoConfig(value: RecordValue): OmoConfigValidation {
  const parsed = OmoConfigLayerSchema.safeParse(value)
  if (parsed.success) return { diagnostics: [], value: parsed.data }
  return {
    diagnostics: parsed.error.issues.map((issue) => `${issue.code}:${issue.path.join(".") || "$"}`),
    value: undefined,
  }
}

export function agentFromMarkdown(parsed: { readonly frontmatter: RecordValue; readonly body: string | undefined }): {
  readonly entry: RecordValue
  readonly restricted: boolean
  readonly unsupported: readonly string[]
} {
  const entry: RecordValue = {}
  const unsupported: string[] = []
  for (const [key, value] of Object.entries(parsed.frontmatter)) {
    if (key === "permission" || key === "permissions") continue
    if (OmoAgentDefSchema.safeParse({ [key]: value }).success) entry[key] = value
    else unsupported.push(key)
  }
  if (parsed.body !== undefined) entry.prompt = parsed.body
  const restricted = parsed.frontmatter.permission !== undefined || parsed.frontmatter.permissions !== undefined
  if (restricted) entry.disable = true
  return { entry, restricted, unsupported }
}
