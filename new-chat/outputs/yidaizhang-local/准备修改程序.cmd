@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0prepare_development.ps1" %*
set "YDZ_RESULT=%ERRORLEVEL%"
if /i not "%~1"=="-CheckOnly" pause
exit /b %YDZ_RESULT%
