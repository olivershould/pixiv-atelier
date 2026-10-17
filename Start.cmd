@echo off
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start.ps1" %*
set "ATELIER_EXIT=%ERRORLEVEL%"
if not "%ATELIER_EXIT%"=="0" if "%~1"=="" pause
exit /b %ATELIER_EXIT%
