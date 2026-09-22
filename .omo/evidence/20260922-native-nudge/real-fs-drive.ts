import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createNativeEditionNudgeHook } from "../../../packages/omo-opencode/src/hooks/native-edition-nudge/hook"
import { createNudgeStateStore, NUDGE_STATE_FILE } from "../../../packages/omo-opencode/src/hooks/native-edition-nudge/state"

const dir = mkdtempSync(join(tmpdir(), "omo-nudge-drive-"))
const store = createNudgeStateStore(dir)
const toasts: string[] = []
const ctx = {
  client: {
    tui: {
      showToast: async (input: { body: { title: string; message: string } }) => {
        toasts.push(`${input.body.title}\n${input.body.message}`)
      },
    },
  },
} as unknown as Parameters<typeof createNativeEditionNudgeHook>[0]

const DAY = 24 * 60 * 60 * 1000
let clock = Date.parse("2026-09-22T00:00:00.000Z")

function hook(installed = false) {
  return createNativeEditionNudgeHook(ctx, {
    store,
    detectNativeEdition: () => installed,
    now: () => clock,
    interactive: () => true,
    version: "qa",
  })
}

function statefile(): string {
  try {
    return readFileSync(join(dir, NUDGE_STATE_FILE), "utf8").trim()
  } catch {
    return "<absent>"
  }
}

console.log("=== a real state directory on disk, no fakes ===")
console.log(`state dir: <tmp>/${dir.split("/").pop()}`)
console.log(`before any session: ${statefile()}`)

console.log("\n--- session 1 (eligible) ---")
await hook().event({ event: { type: "session.created", properties: { info: {} } } })
console.log(`toasts so far: ${toasts.length}`)
console.log(`state file now:\n${statefile()}`)

console.log("\n--- session 2, same process, immediately after ---")
await hook().event({ event: { type: "session.created", properties: { info: {} } } })
console.log(`toasts so far: ${toasts.length}  (a second toast here would be the nagging bug)`)

console.log("\n--- session 3, NEW process, same day ---")
const sameDay = hook()
await sameDay.event({ event: { type: "session.created", properties: { info: {} } } })
console.log(`toasts so far: ${toasts.length}  (still throttled by nextEligibleAt on disk)`)

console.log("\n--- session 4, NEW process, 4 days later ---")
clock += 4 * DAY
await hook().event({ event: { type: "session.created", properties: { info: {} } } })
console.log(`toasts so far: ${toasts.length}  (the 3-day window has opened)`)
console.log(`state file now:\n${statefile()}`)

console.log("\n--- session 5, user has since installed the native edition ---")
clock += 30 * DAY
await hook(true).event({ event: { type: "session.created", properties: { info: {} } } })
console.log(`toasts so far: ${toasts.length}  (must not grow)`)

console.log("\n=== what the user actually saw ===")
for (const [index, toast] of toasts.entries()) console.log(`[toast ${index + 1}]\n${toast}\n`)

rmSync(dir, { recursive: true, force: true })
console.log(`cleanup: removed the temp state dir -> ${statefile()}`)
