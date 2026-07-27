import * as z from "zod"

const OmoCodegraphSettingsShape = {
  enabled: z.boolean(),
  auto_provision: z.boolean(),
  daemon: z.boolean(),
  telemetry: z.boolean(),
  install_dir: z.string().optional(),
  watch_debounce_ms: z.number().finite().nonnegative().optional(),
  excluded_roots: z.array(z.string()).optional(),
}

export const OmoCodegraphSettingsLayerSchema = z.object(OmoCodegraphSettingsShape).partial().strict()

export const OmoCodegraphSettingsSchema = OmoCodegraphSettingsLayerSchema.extend({
  enabled: z.boolean().default(true),
  auto_provision: z.boolean().default(true),
  daemon: z.boolean().default(true),
  telemetry: z.boolean().default(false),
}).strict()

export type OmoCodegraphSettings = z.infer<typeof OmoCodegraphSettingsSchema>
export type OmoCodegraphSettingsLayer = z.infer<typeof OmoCodegraphSettingsLayerSchema>
