param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$appUrl = 'http://127.0.0.1:4318'
$serverFile = Join-Path $projectRoot 'server\index.mjs'
$dataPath = Join-Path $projectRoot '.data'
try {
    $existing = Invoke-RestMethod -Uri "$appUrl/api/health" -TimeoutSec 2
    if ($existing.app -eq 'pixiv-publisher') {
        if (-not $NoBrowser) { Start-Process $appUrl }
        Write-Output "Atelier is already running: $appUrl"
        exit 0
    }
    throw 'Port 4318 is being used by a different app.'
} catch {
    if ($_.Exception.Message -eq 'Port 4318 is being used by a different app.') { throw }
}
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
    throw 'Node.js 22 or newer is required. Install Node.js from https://nodejs.org, then run this launcher again.'
}
$nodeExe = $nodeCommand.Source
$nodeMajor = (& $nodeExe -p 'process.versions.node.split(".")[0]')
if ([int]$nodeMajor -lt 22) { throw 'Node.js 22 or newer is required.' }
New-Item -ItemType Directory -Path $dataPath -Force | Out-Null
$worker = Start-Process -FilePath $nodeExe -ArgumentList @('"' + $serverFile + '"') -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dataPath 'server.log') -RedirectStandardError (Join-Path $dataPath 'server-error.log') -PassThru
$workerRecord = @{ pid = $worker.Id; executable = $nodeExe; startedAt = $worker.StartTime.ToUniversalTime().ToString('o') }
Set-Content -LiteralPath (Join-Path $dataPath 'server.pid') -Value ($workerRecord | ConvertTo-Json -Compress)
$ready = $false
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 200
    try {
        $health = Invoke-RestMethod -Uri "$appUrl/api/health" -TimeoutSec 1
        if ($health.app -eq 'pixiv-publisher') { $ready = $true; break }
    } catch {}
    if ($worker.HasExited) { break }
}
if (-not $ready) { throw "Could not start Atelier. See $dataPath\server-error.log" }
if (-not $NoBrowser) { Start-Process $appUrl }
Write-Output "Atelier is running in the background: $appUrl"
Write-Output 'Keep this computer awake for the queue. Use Stop.ps1 to stop the service.'
