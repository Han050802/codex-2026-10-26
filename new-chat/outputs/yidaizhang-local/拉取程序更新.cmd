@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
set "PYTHONUTF8=1"
if exist "%ProgramFiles%\Git\cmd\git.exe" set "PATH=%ProgramFiles%\Git\cmd;%PATH%"
if exist "%LOCALAPPDATA%\Programs\Git\cmd\git.exe" set "PATH=%LOCALAPPDATA%\Programs\Git\cmd;%PATH%"
set "YDZ_PY_ARGS="
set "TASK_PYTHON=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
if exist "%TASK_PYTHON%" goto run
set "TASK_PYTHON=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
if exist "%TASK_PYTHON%" goto run
set "TASK_PYTHON=%ProgramFiles%\Python312\python.exe"
if exist "%TASK_PYTHON%" goto run
set "TASK_PYTHON=python"
python -c "import sys; assert sys.version_info[0] == 3" >nul 2>&1
if not errorlevel 1 goto run
set "TASK_PYTHON=py"
set "YDZ_PY_ARGS=-3"
py -3 -c "import sys; assert sys.version_info[0] == 3" >nul 2>&1
if not errorlevel 1 goto run
echo 未找到 Python 3，请先安装 Python 3.12 并启用命令行支持。
set "YDZ_EXIT=1"
goto finish
:run
"%TASK_PYTHON%" %YDZ_PY_ARGS% source_sync.py pull %*
set "YDZ_EXIT=%ERRORLEVEL%"
:finish
echo.
if /i not "%~1"=="--no-pause" pause
exit /b %YDZ_EXIT%
