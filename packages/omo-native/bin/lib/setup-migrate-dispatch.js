import { runMigrate } from "./migrate.js"
import { runSetup } from "./setup-import.js"

export async function runSetupOrMigrate(args = process.argv.slice(2)) {
  const [command, ...commandArgs] = args
  if (command === "setup") {
    await runSetup(commandArgs)
    return true
  }
  if (command === "migrate") {
    await runMigrate(commandArgs)
    return true
  }
  return false
}
