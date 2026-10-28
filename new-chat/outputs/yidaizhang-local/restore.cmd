@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
set "PYTHONUTF8=1"
set "TASK_PYTHON=C:\Users\Admin\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
if not exist "%TASK_PYTHON%" set "TASK_PYTHON=python"
if "%~1"=="" goto usage
"%TASK_PYTHON%" maintenance.py restore "%~f1" --data-dir "%~dp0data"
pause
exit /b
:usage
echo 请先停止正式服务，再将备份ZIP文件拖到此文件上执行恢复。
echo 恢复前会自动备份当前数据；恢复后原有登录会话失效。
pause
endlocal
