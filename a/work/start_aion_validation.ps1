$ErrorActionPreference = 'Stop'
$validationRoot = 'D:\Codex\2026-10-26\a\work\aioncore-validation'
New-Item -ItemType Directory -Force -Path $validationRoot,(Join-Path $validationRoot 'data'),(Join-Path $validationRoot 'logs'),(Join-Path $validationRoot 'workspace') | Out-Null
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback,0)
$listener.Start()
$validationPort = $listener.LocalEndpoint.Port
$listener.Stop()
$coreArgs = @('--host','127.0.0.1','--port',"$validationPort",'--local','--identity-mode','local','--data-dir',(Join-Path $validationRoot 'data'),'--work-dir',(Join-Path $validationRoot 'workspace'),'--log-dir',(Join-Path $validationRoot 'logs'),'--managed-resources-mode','bundled')
$validationProcess = Start-Process -FilePath 'D:\AIONUI\resources\bundled-aioncore\win32-x64\aioncore.exe' -ArgumentList $coreArgs -WorkingDirectory $validationRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $validationRoot 'stdout.log') -RedirectStandardError (Join-Path $validationRoot 'stderr.log')
$validationState = @{pid=$validationProcess.Id;port=$validationPort;base_url="http://127.0.0.1:$validationPort";root=$validationRoot;started_at=(Get-Date).ToString('o')}
$validationState | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $validationRoot 'state.json') -Encoding utf8
$validationState | ConvertTo-Json -Compress
