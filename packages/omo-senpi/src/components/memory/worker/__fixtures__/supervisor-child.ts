import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

const [mode, runDir] = process.argv.slice(2)
if (mode === undefined || runDir === undefined) throw new Error("mode and runDir are required")

const writeMarker = async (name: string, value: unknown): Promise<void> => {
  await writeFile(join(runDir, name), `${JSON.stringify(value)}\n`, "utf8")
}

if (mode === "inspect") {
  const ledger = JSON.parse(await readFile(join(runDir, "ledger.json"), "utf8")) as Record<string, unknown>
  await writeMarker("child-observation.json", {
    pid: ledger.pid,
    processStart: ledger.processStart,
    childPid: ledger.childPid,
    childProcessStart: ledger.childProcessStart,
  })
  process.exit(23)
}

await writeMarker("child-started.json", { pid: process.pid })

if (mode === "graceful") {
  process.once("SIGTERM", () => {
    void writeMarker("child-terminated.json", { signal: "SIGTERM" }).then(() => process.exit(0))
  })
} else if (mode === "stubborn") {
  process.on("SIGTERM", () => {
    void writeMarker("child-terminated.json", { signal: "SIGTERM" })
  })
}

setInterval(() => undefined, 60_000)
