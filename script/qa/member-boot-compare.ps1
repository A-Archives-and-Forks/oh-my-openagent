param([Parameter(Mandatory=$true)][string]$BaseRef, [Parameter(Mandatory=$true)][string]$OutputDirectory)
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true
$source = (git rev-parse --show-toplevel).Trim()
$baseline = Join-Path $env:RUNNER_TEMP "member-boot-base"
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
git fetch --depth=1 origin $BaseRef
git worktree add --detach $baseline FETCH_HEAD
try {
  # Only observation code is overlaid. Product imports resolve against the selected dev tree.
  $diagnostics = @(
    "packages/senpi-task/src/lifecycle/__fixtures__/real-cold-revive.ts",
    "packages/senpi-task/src/lifecycle/__fixtures__/cold-revive-trace.ts",
    "packages/senpi-task/src/lifecycle/__fixtures__/cold-revive-child-trace.ts",
    "script/qa/member-boot-profile.ts"
  )
  foreach ($relative in $diagnostics) {
    $target = Join-Path $baseline $relative
    New-Item -ItemType Directory -Force -Path (Split-Path $target) | Out-Null
    Copy-Item (Join-Path $source $relative) $target
  }
  Push-Location $baseline
  try {
    $env:HUSKY = "0"
    bun install --ignore-scripts --frozen-lockfile
    bun run script/qa/member-boot-profile.ts (Join-Path $OutputDirectory "base.json")
  } finally { Pop-Location }
  bun run script/qa/member-boot-profile.ts (Join-Path $OutputDirectory "candidate.json")
  bun run script/qa/member-boot-diff.ts (Join-Path $OutputDirectory "base.json") (Join-Path $OutputDirectory "candidate.json") (Join-Path $OutputDirectory "diff.json")
} finally {
  Set-Location $source
  # Bun's nested bundled dependencies exceed Git for Windows' default path limit.
  git -c core.longpaths=true worktree remove --force $baseline
}
