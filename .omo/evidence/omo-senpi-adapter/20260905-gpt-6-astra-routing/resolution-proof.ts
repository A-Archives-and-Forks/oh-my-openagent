import { CATEGORY_MODEL_REQUIREMENTS } from "../../../../../packages/model-core/src/category-model-requirements"
import { resolveModelWithFallback } from "../../../../../packages/model-core/src/model-resolver"

for (const [name, requirement] of Object.entries(CATEGORY_MODEL_REQUIREMENTS).filter(([name]) => ["unspecified-high", "ultrabrain", "deep"].includes(name))) {
  const astra = resolveModelWithFallback({ fallbackChain: requirement.fallbackChain, availableModels: new Set(["openai-codex/gpt-6-astra"]), systemDefaultModel: "system/default" })
  const sol = resolveModelWithFallback({ fallbackChain: requirement.fallbackChain, availableModels: new Set(["openai-codex/gpt-5.6-sol"]), systemDefaultModel: "system/default" })
  console.log(JSON.stringify({ name, astra, sol }))
}
