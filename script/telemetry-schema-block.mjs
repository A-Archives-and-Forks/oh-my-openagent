import { pathToFileURL } from "node:url"

import { OMO_NATIVE_PROPERTY_ALLOWLISTS } from "../packages/omo-senpi/src/components/telemetry/product-identity.ts"

const BEGIN_SENTINEL = "<!-- BEGIN GENERATED SCHEMA -->"
const END_SENTINEL = "<!-- END GENERATED SCHEMA -->"

export function generateTelemetrySchemaBlock(allowlists = OMO_NATIVE_PROPERTY_ALLOWLISTS) {
  if (allowlists === null || typeof allowlists !== "object" || Array.isArray(allowlists)) {
    throw new TypeError("Telemetry property allowlists must be an object")
  }

  const entries = Object.entries(allowlists)
  if (entries.length === 0) {
    throw new Error("Telemetry property allowlists must contain at least one event")
  }

  const rows = entries.map(([eventName, properties]) => {
    assertMarkdownIdentifier(eventName, "event name")
    if (!Array.isArray(properties) || properties.length === 0) {
      throw new Error(`Telemetry event ${eventName} must contain at least one allowed property`)
    }

    const seen = new Set()
    const propertyCells = properties.map((property) => {
      assertMarkdownIdentifier(property, `property for ${eventName}`)
      if (seen.has(property)) {
        throw new Error(`Telemetry event ${eventName} contains duplicate property ${property}`)
      }
      seen.add(property)
      return `\`${property}\``
    })

    return `| \`${eventName}\` | ${propertyCells.join(", ")} |`
  })

  return [
    BEGIN_SENTINEL,
    "## Event schema",
    "",
    "| Event | Allowed properties |",
    "|-------|--------------------|",
    ...rows,
    END_SENTINEL,
  ].join("\n")
}

function assertMarkdownIdentifier(value, description) {
  if (typeof value !== "string" || value.length === 0 || /[\n\r`|]/u.test(value)) {
    throw new Error(`Telemetry ${description} must be a non-empty Markdown-safe string`)
  }
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  process.stdout.write(`${generateTelemetrySchemaBlock()}\n`)
}
