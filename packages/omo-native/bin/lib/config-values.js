export class UnsupportedConfigValue extends Error {
  constructor() {
    super("unsupported OpenCode config expression; translate this value manually")
    this.name = "UnsupportedConfigValue"
  }
}

// Preserve references, not their current secret values. Neither file references nor
// malformed variable expressions may become literal credentials in the target.
export function translateOpencodeValue(value) {
  const translated = value.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name) => `\${${name}}`)
  if (/\{(?:env|file):/.test(translated)) throw new UnsupportedConfigValue()
  return translated
}
