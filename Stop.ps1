$ErrorActionPreference = 'Stop'
try {
    . (Join-Path $PSScriptRoot 'launch\Atelier.Launcher.ps1')
    Invoke-AtelierStop -ProjectRoot $PSScriptRoot
    exit 0
} catch {
    $message = [string]$_.Exception.Message
    try { [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'launcher-stop-error.log'), $message, (New-Object Text.UTF8Encoding($false))) } catch {}
    Write-Error $message -ErrorAction Continue
    exit 1
}
