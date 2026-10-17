@echo off
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0Setup-Tagger.ps1" %*
set "ATELIER_EXIT=%ERRORLEVEL%"
if "%~1"=="" pause
exit /b %ATELIER_EXIT%
