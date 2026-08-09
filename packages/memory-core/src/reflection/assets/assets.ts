import { readFileSync } from "node:fs"
import { join } from "node:path"

export interface ReflectionPersonaSection {
  heading: string
  level: number
  body: string
}

export interface ReflectionPersona {
  markdown: string
  sections: ReflectionPersonaSection[]
}

const PERSONA_PATH = join(import.meta.dir, "reflection-persona.md")

function parseSections(markdown: string): ReflectionPersonaSection[] {
  const sections: ReflectionPersonaSection[] = []
  const lines = markdown.split("\n")
  let current: ReflectionPersonaSection | null = null
  let inFence = false
  for (const line of lines) {
    if (line.startsWith("```")) inFence = !inFence
    const match = inFence ? null : /^(#{1,6})\s+(.+?)\s*$/.exec(line)
    if (match) {
      if (current) sections.push(current)
      current = { heading: match[2]!, level: match[1]!.length, body: "" }
      continue
    }
    if (current) current.body += line + "\n"
  }
  if (current) sections.push(current)
  return sections
}

export function loadReflectionPersona(): ReflectionPersona {
  const markdown = readFileSync(PERSONA_PATH, "utf8")
  return { markdown, sections: parseSections(markdown) }
}
