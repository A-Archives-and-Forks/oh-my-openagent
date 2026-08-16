Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OmoConsoleHost {
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool AllocConsole();
}
'@

if (-not [OmoConsoleHost]::AllocConsole()) {
  $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  [Console]::Error.WriteLine("AllocConsole failed: $errorCode")
  exit 1
}

$bun = $env:OMO_PROBE_BUN
$script = $env:OMO_PROBE_SCRIPT
$mode = $env:OMO_PROBE_MODE
$root = $env:OMO_PROBE_ROOT
if (-not $bun -or -not $script -or -not $mode -or -not $root) {
  [Console]::Error.WriteLine("Missing OMO probe host environment")
  exit 1
}

$startInfo = New-Object System.Diagnostics.ProcessStartInfo
$startInfo.FileName = $bun
$startInfo.Arguments = "`"$script`" --parent $mode `"$root`""
$startInfo.UseShellExecute = $false
$startInfo.RedirectStandardInput = $true
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true

$parent = [System.Diagnostics.Process]::Start($startInfo)
$ready = $parent.StandardOutput.ReadLine()
[Console]::Out.WriteLine($ready)
$stop = [Console]::In.ReadLine()
$parent.StandardInput.WriteLine($stop)
$parent.StandardInput.Close()
$parent.WaitForExit()

$stderr = $parent.StandardError.ReadToEnd()
if ($stderr) {
  [Console]::Error.Write($stderr)
}
exit $parent.ExitCode
