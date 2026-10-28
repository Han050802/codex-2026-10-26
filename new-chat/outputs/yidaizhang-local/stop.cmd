@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
set "PYTHONUTF8=1"
set "TASK_PYTHON=C:\Users\Admin\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
if not exist "%TASK_PYTHON%" set "TASK_PYTHON=python"
"%TASK_PYTHON%" stop.py %*
pause
endlocal
