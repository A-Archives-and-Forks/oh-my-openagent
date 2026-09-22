import { notificationMessages } from "../../../packages/omo-senpi/src/components/config-startup/index"

const migration = {
  error: undefined,
  migratedFrom: ["~/.config/opencode/oh-my-openagent.jsonc"],
  journalResumed: false,
  results: [{ diagnostics: ["skipped: [opencode].model_fallback legacy=true kept=false"] }],
} as never
const config = { diagnostics: [{ message: "JSONC parse error" }] } as never

console.log("--- what an OmO Native user sees at startup ---")
for (const m of notificationMessages(migration, config)) console.log(`[${m.type}] ${m.message}`)
