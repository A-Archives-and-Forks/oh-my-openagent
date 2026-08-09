#!/usr/bin/env node
import { runLauncher } from "./lib/launcher.js"

try {
  await runLauncher()
} catch (error) {
  console.error(`omo: ${error.message}`)
  process.exitCode = 1
}
