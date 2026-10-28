$ErrorActionPreference = 'Stop'
$validationRoot = 'D:\Codex\2026-10-26\a\work\aioncore-validation'
$validationState = Get-Content -LiteralPath (Join-Path $validationRoot 'state.json') -Raw | ConvertFrom-Json
$validationPid = [int]$validationState.pid
if ($validationPid -ne 20960) { throw 'Unexpected validation process ID' }
$rows = @(Get-CimInstance Win32_Process)
$rootRow = $rows | Where-Object { $_.ProcessId -eq $validationPid }
if (-not $rootRow -or $rootRow.Name -ne 'aioncore.exe' -or -not $rootRow.CommandLine.Contains($validationRoot)) { throw 'Validation process identity mismatch; refusing cleanup' }
$selected = [System.Collections.Generic.HashSet[int]]::new()
$null = $selected.Add($validationPid)
for ($pass = 0; $pass -lt 12; $pass++) {
  foreach ($entry in $rows) {
    if ($selected.Contains([int]$entry.ParentProcessId) -and $entry.CreationDate -ge $rootRow.CreationDate) { $null = $selected.Add([int]$entry.ProcessId) }
  }
}
if ($selected.Contains(31112) -or $selected.Contains(28216)) { throw 'Production PID found in cleanup list; refusing cleanup' }
$targets = @($rows | Where-Object { $selected.Contains([int]$_.ProcessId) })
$before = @($targets | Select-Object Name,ProcessId,ParentProcessId,CreationDate,ExecutablePath)
Stop-Process -Id $validationPid -Force -ErrorAction SilentlyContinue
foreach ($target in $targets) {
  if ($target.ProcessId -eq $validationPid) { continue }
  $live = Get-CimInstance Win32_Process -Filter "ProcessId = $($target.ProcessId)" -ErrorAction SilentlyContinue
  if ($live -and $live.CreationDate -eq $target.CreationDate -and $live.Name -eq $target.Name) { Stop-Process -Id $target.ProcessId -Force -ErrorAction SilentlyContinue }
}
Start-Sleep -Milliseconds 800
$remaining = @()
foreach ($target in $targets) {
  $live = Get-CimInstance Win32_Process -Filter "ProcessId = $($target.ProcessId)" -ErrorAction SilentlyContinue
  if ($live -and $live.CreationDate -eq $target.CreationDate) { $remaining += ($live | Select-Object Name,ProcessId,ParentProcessId) }
}
$listeners = @(Get-NetTCPConnection -State Listen -LocalPort $validationState.port -ErrorAction SilentlyContinue)
$production = @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -in @(31112,28216) } | Select-Object Name,ProcessId,ExecutablePath)
$report = @{validation_pid=$validationPid;before=$before;remaining=$remaining;remaining_count=$remaining.Count;test_port_listeners=$listeners.Count;production=$production;finished_at=(Get-Date).ToString('o')}
$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $validationRoot 'cleanup-result.json') -Encoding utf8
@{validation_pid=$validationPid;target_count=$targets.Count;remaining_count=$remaining.Count;test_port_listeners=$listeners.Count;production=$production} | ConvertTo-Json -Depth 4 -Compress
if ($remaining.Count -gt 0 -or $listeners.Count -gt 0) { throw 'Validation process cleanup incomplete' }
