import { REASONING_LEVELS } from "@oh-my-opencode/model-core"
import * as z from "zod"

const REASONING_LEVELS_OR_AUTO = [...REASONING_LEVELS, "auto"] as const

export const OmoReasoningSchema = z.union([
  z.enum(REASONING_LEVELS_OR_AUTO),
  z.string(),
])

export const OmoModelRefObjectSchema = z.object({
  model: z.string(),
  reasoning: OmoReasoningSchema.optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  max_tokens: z.number().int().positive().optional(),
  provider_options: z.record(z.string(), z.unknown()).optional(),
}).strict()

export const OmoModelRefSchema = z.union([z.string(), OmoModelRefObjectSchema])

export type OmoReasoning = z.infer<typeof OmoReasoningSchema>
export type OmoModelRefObject = z.infer<typeof OmoModelRefObjectSchema>
export type OmoModelRef = z.infer<typeof OmoModelRefSchema>
