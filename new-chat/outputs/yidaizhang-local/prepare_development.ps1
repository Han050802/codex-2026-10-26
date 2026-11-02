param([switch]$CheckOnly, [switch]$NoOpen)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$repoUrl = 'https://github.com/Han050802/codex-2026-10-26.git'
$checkout = Join-Path $env:USERPROFILE 'source\daizhangtai'
$appFolder = Join-Path $checkout 'new-chat\outputs\yidaizhang-local'

function Find-Git {
    $command = Get-Command git.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    foreach ($candidate in @("$env:ProgramFiles\Git\cmd\git.exe", "$env:LOCALAPPDATA\Programs\Git\cmd\git.exe")) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
}
function Find-Python {
    $candidates = @("$env:LOCALAPPDATA\Programs\Python\Python312\python.exe", "$env:USERPROFILE\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe")
    $command = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($command -and $command.Source -notlike '*\WindowsApps\*') { $candidates += $command.Source }
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            & $candidate -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>$null
            if ($LASTEXITCODE -eq 0) { return $candidate }
        }
    }
}
function Install-Prerequisite([string]$Id) {
    $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
    if (-not $winget) { throw '未找到 Windows 应用安装程序。请先从 https://git-scm.com/download/win 和 https://www.python.org/downloads/windows/ 安装 Git 与 Python 3.12，然后重新运行。' }
    Write-Host "正在安装开发所需组件：$Id"
    & $winget.Source install --id $Id --exact --source winget --silent --accept-package-agreements --accept-source-agreements --no-upgrade
    if ($LASTEXITCODE -ne 0) { throw "组件 $Id 未安装成功，请根据上方提示完成安装后重新运行。" }
}

try {
    $gitExe = Find-Git
    $pythonExe = Find-Python
    if ($CheckOnly) {
        Write-Host ('Git：' + $(if ($gitExe) { $gitExe } else { '未安装，正式运行时将尝试通过 winget 安装 Git.Git' }))
        Write-Host ('Python：' + $(if ($pythonExe) { $pythonExe } else { '未安装，正式运行时将尝试通过 winget 安装 Python.Python.3.12' }))
        Write-Host "源码目录：$appFolder"
        Write-Host '检查结束；未安装组件、未下载源码、未启动服务。'
        exit 0
    }
    if (-not $gitExe) { Install-Prerequisite 'Git.Git'; $gitExe = Find-Git }
    if (-not $pythonExe) { Install-Prerequisite 'Python.Python.3.12'; $pythonExe = Find-Python }
    if (-not $gitExe -or -not $pythonExe) { throw '组件尚未能在当前窗口使用。请关闭此窗口后重新运行。' }
    if (Test-Path -LiteralPath $checkout) {
        if (-not (Test-Path -LiteralPath (Join-Path $checkout '.git'))) { throw "目标文件夹已存在且不是 Git 仓库，已保留原文件：$checkout" }
        $origin = & $gitExe -C $checkout remote get-url origin
        if ($LASTEXITCODE -ne 0 -or $origin.Trim().TrimEnd('/') -ne $repoUrl) { throw '现有目录不属于指定代账台仓库，已停止。' }
        Write-Host '开发目录已存在，保留所有本地修改。需要更新时运行目录中的“拉取程序更新.cmd”。'
    } else {
        New-Item -ItemType Directory -Path (Split-Path -Parent $checkout) -Force | Out-Null
        & $gitExe clone --branch main --single-branch $repoUrl $checkout
        if ($LASTEXITCODE -ne 0) { throw '下载源码失败，请检查 GitHub 网络连接。未启动任何工作台服务。' }
    }
    if (-not (Test-Path -LiteralPath (Join-Path $appFolder 'source_sync.py'))) { throw '现有源码版本缺少同步工具。请让 Codex 在该源码目录检查本地修改，并执行 git pull --ff-only origin main 更新后重试。' }
    $desktopFolder = [Environment]::GetFolderPath('Desktop')
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut((Join-Path $desktopFolder '代账台程序源码.lnk'))
    $shortcut.TargetPath = $env:WINDIR + '\explorer.exe'
    $shortcut.Arguments = '"' + $appFolder + '"'
    $shortcut.Save()
    Write-Host "准备完成：$appFolder"
    Write-Host '在 Codex 中打开该文件夹，阅读“多电脑使用说明.md”后修改程序。'
    Write-Host '日常账务仍使用“打开代账台.cmd”连接办公室主机。此工具没有创建独立账套。'
    if (-not $NoOpen) { Start-Process explorer.exe -ArgumentList ('"' + $appFolder + '"') }
} catch {
    Write-Host ('准备未完成：' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
