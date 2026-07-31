$ErrorActionPreference = "Stop"
$comp = "C:\Users\pss\OneDrive\Documents\github\oh-my-openagent-144\packages\omo-codex\plugin\components\start-work-continuation"
$cli = Join-Path $comp "dist\cli.js"

$realCodexConfig = Join-Path $env:USERPROFILE ".codex\config.toml"
$before = if (Test-Path $realCodexConfig) { (Get-FileHash $realCodexConfig -Algorithm SHA256).Hash } else { "ABSENT" }
Write-Output "real ~/.codex/config.toml sha256 BEFORE: $before"

$ws = Join-Path ([System.IO.Path]::GetTempPath()) ("swc-smoke-" + [guid]::NewGuid().ToString("N").Substring(0,8))
New-Item -ItemType Directory -Force -Path (Join-Path $ws ".omo\plans") | Out-Null
$plan = "## TODOs" + [char]10 + "- [ ] 1. Task one" + [char]10 + "- [ ] 2. Task two" + [char]10
[System.IO.File]::WriteAllText((Join-Path $ws ".omo\plans\test.md"), $plan)
$boulder = '{"schema_version":2,"active_work_id":"w1","works":{"w1":{"work_id":"w1","active_plan":".omo/plans/test.md","plan_name":"test","session_ids":["codex:smoke-session"],"status":"active"}}}'
[System.IO.File]::WriteAllText((Join-Path $ws ".omo\boulder.json"), $boulder)

function Invoke-Hook([string]$label, [string]$lastMsg) {
    $payload = [ordered]@{
        session_id            = "smoke-session"
        turn_id               = "t1"
        transcript_path       = ""
        cwd                   = $ws
        hook_event_name       = "Stop"
        model                 = "gpt-5.6-sol"
        permission_mode       = "default"
        stop_hook_active      = $false
        last_assistant_message = $lastMsg
    } | ConvertTo-Json -Compress
    $file = Join-Path $ws "payload.json"
    [System.IO.File]::WriteAllText($file, $payload)
    $raw = cmd /c "node `"$cli`" hook stop < `"$file`""
    $out = ($raw | Where-Object { $_ -notmatch '^Active code page:' }) -join ""
    $trimmed = $out.Trim()
    $verdict = if ($trimmed -eq "") { "NO OUTPUT (Stop allowed)" } elseif ($trimmed -like '*"decision":"block"*') { "BLOCK (continuation injected)" } else { "UNEXPECTED" }
    Write-Output ""
    Write-Output "=== $label ==="
    Write-Output "last_assistant_message (escaped): $($lastMsg -replace "`n", '\n')"
    Write-Output "observed: $verdict"
    Write-Output "raw output length: $($trimmed.Length)"
}

Invoke-Hook "A. ordinary answer, plan still has unchecked tasks" "Finished task one."
Invoke-Hook "B. external blocker marker on the FIRST line" "<start-work-blocked-external>`nBlocker: deploy credential DEPLOY_TOKEN is not provisioned.`nResume when the token exists in the vault."
Invoke-Hook "C. marker mentioned but NOT on the first line" "I might need to emit this later:`n<start-work-blocked-external>"

Remove-Item -Recurse -Force $ws
Write-Output ""
Write-Output "temp workspace removed: $ws"
$after = if (Test-Path $realCodexConfig) { (Get-FileHash $realCodexConfig -Algorithm SHA256).Hash } else { "ABSENT" }
Write-Output "real ~/.codex/config.toml sha256 AFTER:  $after"
Write-Output "unchanged: $($before -eq $after)"
