function parseArgs(args) {
  let dryRun = false
  let yes = false
  for (const argument of args) {
    if (argument === "--dry-run") dryRun = true
    else if (argument === "--yes") yes = true
    else if (argument === "--help" || argument === "-h") return { kind: "help" }
    else throw new Error(`unknown migrate argument: ${argument}`)
  }
  if (dryRun && yes) throw new Error("--dry-run and --yes cannot be used together")
  return { kind: dryRun ? "dry-run" : yes ? "apply" : "preview" }
}

function migrationHelp() {
  return [
    "Usage: omo migrate [--dry-run|--yes]",
    "",
    "Without --yes, omo migrate previews changes without writing.",
    "Use --dry-run for an explicit read-only preview.",
  ]
}

/**
 * Migration is deliberately lazy: normal CLI commands, --help, and credential-only
 * setup work before the generated bundle exists. Migration and MCP imports use its
 * canonical validators; package and test build paths generate it before those runs.
 */
export async function runMigrate(args = process.argv.slice(2), options = {}) {
  const parsed = parseArgs(args)
  const out = options.out ?? ((line) => process.stdout.write(`${line}\n`))
  if (parsed.kind === "help") {
    for (const line of migrationHelp()) out(line)
    return { kind: "help" }
  }
  const { applyMigrationPlan, planMigration } = await import("./migration-planner.js")
  const plan = planMigration(options)
  if (parsed.kind !== "apply") out(parsed.kind === "dry-run" ? "DRY RUN: no files will be written" : "Preview only: pass --yes to write")
  for (const line of plan.report) out(line)
  if (plan.warnings.length > 0) out(`manual-review: ${plan.warnings.join(", ")}`)
  if (parsed.kind === "apply") applyMigrationPlan(plan)
  return { kind: parsed.kind, report: plan.report, warnings: plan.warnings }
}
