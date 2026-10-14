$ErrorActionPreference = 'Stop'
$pidPath = Join-Path $PSScriptRoot '.data\server.pid'
if (-not (Test-Path -LiteralPath $pidPath)) { Write-Output 'No launcher-managed service found.'; exit 0 }
$record = Get-Content -LiteralPath $pidPath -Raw | ConvertFrom-Json
if (-not $record.pid -or -not $record.executable -or -not $record.startedAt) { throw 'This process record is incomplete. The service was not stopped.' }
$workerId = [int]$record.pid
$process = Get-Process -Id $workerId -ErrorAction SilentlyContinue
if ($process -and $process.Path -eq $record.executable -and $process.StartTime.ToUniversalTime().Ticks -eq ([datetime]$record.startedAt).ToUniversalTime().Ticks) {
    Stop-Process -Id $workerId
    Write-Output 'Atelier service stopped. Drafts and queue data remain saved.'
} elseif ($process) {
    throw 'The saved process ID now belongs to another application. It was not stopped.'
} else {
    Write-Output 'The service is already stopped.'
}
