param([switch]$NoBrowser, [string]$NodeExecutable)
$ErrorActionPreference = 'Stop'
try {
    . (Join-Path $PSScriptRoot 'launch\Atelier.Launcher.ps1')
    Invoke-AtelierStart -ProjectRoot $PSScriptRoot -NoBrowser:$NoBrowser -NodeExecutable $NodeExecutable
    exit 0
} catch {
    $message = [string]$_.Exception.Message
    try { [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'launcher-error.log'), $message, (New-Object Text.UTF8Encoding($false))) } catch {}
    Write-Error $message -ErrorAction Continue
    exit 1
}
