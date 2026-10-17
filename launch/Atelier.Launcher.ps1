Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-AtelierPaths([string]$ProjectRoot) {
    $root = [IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\', '/')
    return @{ Root = $root; Server = (Join-Path $root 'server\index.mjs'); Data = (Join-Path $root '.data');
        Record = (Join-Path $root '.data\server.pid'); Url = 'http://127.0.0.1:4318'; Port = 4318 }
}
function Test-AtelierPath([string]$Left, [string]$Right) {
    if (-not $Left -or -not $Right) { return $false }
    return [StringComparer]::OrdinalIgnoreCase.Equals([IO.Path]::GetFullPath($Left), [IO.Path]::GetFullPath($Right))
}
function Get-AtelierNodeVersion([string]$Executable) {
    $savedOptions = [Environment]::GetEnvironmentVariable('NODE_OPTIONS', 'Process')
    $savedPath = [Environment]::GetEnvironmentVariable('NODE_PATH', 'Process')
    try {
        [Environment]::SetEnvironmentVariable('NODE_OPTIONS', $null, 'Process')
        [Environment]::SetEnvironmentVariable('NODE_PATH', $null, 'Process')
        $output = & $Executable -p 'process.versions.node' 2>&1
        if ($LASTEXITCODE -ne 0) { throw 'The selected Node.js runtime could not start.' }
        try { return [version]([string]$output).Trim() } catch { throw 'The selected Node.js runtime returned an invalid version.' }
    } finally {
        [Environment]::SetEnvironmentVariable('NODE_OPTIONS', $savedOptions, 'Process')
        [Environment]::SetEnvironmentVariable('NODE_PATH', $savedPath, 'Process')
    }
}
function Test-AtelierIndependentRuntime([string]$Executable) {
    return $Executable -and $Executable -notmatch '(?i)(^|[\\/])(?:codex-runtimes|codex-primary-runtime|CodexData|\.codex|WindowsApps)([\\/]|$)'
}
function Get-AtelierSystemNodeCandidates {
    $candidates = @(Get-Command node.exe -CommandType Application -All -ErrorAction SilentlyContinue | ForEach-Object { $_.Source })
    foreach ($directory in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
        if ($directory) { $candidates += Join-Path $directory 'nodejs\node.exe' }
    }
    return @($candidates | Select-Object -Unique)
}
function Resolve-AtelierNode($Paths, [string]$NodeExecutable) {
    $bundled = Join-Path $Paths.Root '.runtime\node\node.exe'
    $selected = if (Test-Path -LiteralPath $bundled -PathType Leaf) { $bundled } else { $NodeExecutable }
    if (-not $selected) {
        foreach ($candidate in @(Get-AtelierSystemNodeCandidates)) {
            if (-not (Test-AtelierIndependentRuntime $candidate) -or -not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
            $candidate = (Resolve-Path -LiteralPath $candidate).ProviderPath
            if (-not (Test-AtelierIndependentRuntime $candidate) -or [IO.Path]::GetFileName($candidate) -ine 'node.exe') { continue }
            try { if ((Get-AtelierNodeVersion $candidate) -ge [version]'22.13.0') { return $candidate } }
            catch { continue }
        }
        throw 'Node.js 22.13 or newer was not found. Install an independent Node.js, include .runtime\node\node.exe, or pass -NodeExecutable with its full path. Codex runtimes and WindowsApps shims are not used.'
    }
    if (-not [IO.Path]::IsPathRooted($selected) -or -not (Test-Path -LiteralPath $selected -PathType Leaf)) { throw 'NodeExecutable must be the full path to an installed node.exe.' }
    $selected = (Resolve-Path -LiteralPath $selected).ProviderPath
    if ([IO.Path]::GetFileName($selected) -ine 'node.exe' -or -not (Test-AtelierIndependentRuntime $selected)) {
        throw 'Use the bundled runtime or an independent Node.js installation, not a Codex runtime or WindowsApps shim.'
    }
    if ((Get-AtelierNodeVersion $selected) -lt [version]'22.13.0') { throw 'Node.js 22.13 or newer is required.' }
    return $selected
}
function Invoke-AtelierLocked($Paths, [scriptblock]$Action) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $key = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Paths.Root.ToLowerInvariant())))).Replace('-', '') }
    finally { $sha.Dispose() }
    $mutex = New-Object Threading.Mutex($false, "Local\PixivAtelier-$key")
    $acquired = $false
    try {
        try { $acquired = $mutex.WaitOne(60000) } catch [Threading.AbandonedMutexException] { $acquired = $true }
        if (-not $acquired) { throw 'Another launcher is still starting or stopping this app. Try again shortly.' }
        & $Action
    } finally { if ($acquired) { $mutex.ReleaseMutex() }; $mutex.Dispose() }
}
function Get-AtelierProcess([int]$WorkerId) {
    $worker = Get-Process -Id $WorkerId -ErrorAction SilentlyContinue
    if (-not $worker) { return $null }
    $details = Get-CimInstance Win32_Process -Filter "ProcessId = $WorkerId" -ErrorAction Stop
    return @{ Id = $worker.Id; Executable = $worker.Path; StartedAt = $worker.StartTime.ToUniversalTime().ToString('o');
        StartTicks = [string]$worker.StartTime.ToUniversalTime().Ticks; CommandLine = $details.CommandLine }
}
function Get-AtelierListeners($Paths) {
    return @(Get-NetTCPConnection -LocalPort $Paths.Port -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
        @{ Id = [int]$_.OwningProcess; Address = [string]$_.LocalAddress }
    })
}
function Test-AtelierEntry($Process, $Paths) {
    if (-not $Process -or -not $Process.Executable -or [IO.Path]::GetFileName($Process.Executable) -ine 'node.exe') { return $false }
    if (-not (Test-AtelierIndependentRuntime $Process.Executable)) { return $false }
    $match = [regex]::Match([string]$Process.CommandLine, '^\s*(?:"(?<exe>[^"]+)"|(?<exe>\S+))\s+(?:"(?<entry>[^"]+)"|(?<entry>\S+))\s*$')
    return $match.Success -and [IO.Path]::IsPathRooted($match.Groups['entry'].Value) -and
        (Test-AtelierPath $match.Groups['exe'].Value $Process.Executable) -and (Test-AtelierPath $match.Groups['entry'].Value $Paths.Server)
}
function Read-AtelierRecord($Paths) {
    if (-not (Test-Path -LiteralPath $Paths.Record -PathType Leaf)) { return $null }
    try { $record = Get-Content -LiteralPath $Paths.Record -Raw -Encoding UTF8 | ConvertFrom-Json }
    catch { throw 'The service ownership record is invalid. No process was stopped.' }
    foreach ($field in @('version', 'pid', 'executable', 'serverFile', 'projectRoot', 'startTicks', 'port', 'token')) {
        if ($null -eq $record.PSObject.Properties[$field]) { throw 'The service record is from an older launcher or is incomplete. No process was stopped.' }
    }
    if ($record.version -ne 2 -or $record.pid -isnot [int] -or $record.pid -le 0 -or $record.port -ne $Paths.Port -or
        [string]$record.startTicks -notmatch '^\d+$' -or [string]$record.token -notmatch '^[a-f0-9]{64}$' -or
        -not (Test-AtelierPath $record.projectRoot $Paths.Root) -or -not (Test-AtelierPath $record.serverFile $Paths.Server)) {
        throw 'The service ownership record does not match this app. No process was stopped.'
    }
    return $record
}
function Test-AtelierOwned($Process, $Record, $Paths) {
    return $Process -and $Record -and $Process.Id -eq $Record.pid -and
        (Test-AtelierPath $Process.Executable $Record.executable) -and [string]$Process.StartTicks -eq [string]$Record.startTicks -and (Test-AtelierEntry $Process $Paths)
}
function Get-AtelierHealth($Paths) { return Invoke-RestMethod -Uri ($Paths.Url + '/api/health') -TimeoutSec 2 -MaximumRedirection 0 }
function Get-AtelierService($Paths) {
    $listeners = @(Get-AtelierListeners $Paths)
    if (-not $listeners.Count) { return $null }
    $ids = @($listeners | ForEach-Object { $_.Id } | Select-Object -Unique)
    if ($ids.Count -ne 1 -or @($listeners | Where-Object { $_.Address -ne '127.0.0.1' }).Count) { throw 'Port 4318 belongs to another or unverified service. It was left untouched.' }
    $worker = Get-AtelierProcess $ids[0]
    if (-not (Test-AtelierEntry $worker $Paths)) { throw 'Port 4318 is occupied by a different app. It was left untouched.' }
    $health = Get-AtelierHealth $Paths
    if (-not $health -or $health.ok -ne $true -or $health.app -ne 'pixiv-publisher') { throw 'The existing service did not pass its health check. It was left untouched.' }
    return $worker
}
function Write-AtelierRecord($Paths, $Record) {
    $temporary = $Paths.Record + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
    try {
        [IO.File]::WriteAllText($temporary, ($Record | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
        Move-Item -LiteralPath $temporary -Destination $Paths.Record -Force
    } finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force } }
}
function Start-AtelierWorker($Paths, [string]$Executable, [string]$Token) {
    $saved = @{}
    $names = @(Get-ChildItem Env: | Where-Object { $_.Name -match '^(CODEX_|OPENAI_|PIXIV_TAGGER_|TAGGER_)' -or $_.Name -in @('PYTHONHOME', 'PYTHONPATH', 'NODE_OPTIONS', 'NODE_PATH', 'PIXIV_CONNECTOR_URL', 'PIXIV_CONNECTOR_TOKEN', 'PIXIV_CHROME_USER_DATA_DIR', 'PORT', 'PIXIV_LAUNCHER_TOKEN') } | ForEach-Object { $_.Name })
    $names = @($names + @('PORT', 'PIXIV_LAUNCHER_TOKEN') | Select-Object -Unique)
    try {
        foreach ($name in $names) { $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process'); [Environment]::SetEnvironmentVariable($name, $null, 'Process') }
        $env:PORT = [string]$Paths.Port
        $env:PIXIV_LAUNCHER_TOKEN = $Token
        $worker = Start-Process -FilePath $Executable -ArgumentList @('"' + $Paths.Server + '"') -WorkingDirectory $Paths.Root -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $Paths.Data 'server.log') -RedirectStandardError (Join-Path $Paths.Data 'server-error.log')
        return $worker.Id
    } finally {
        foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') }
    }
}
function Open-AtelierWindow($Paths) { Start-Process $Paths.Url }
function Wait-AtelierReady($Paths, $Record) {
    for ($attempt = 0; $attempt -lt 120; $attempt++) {
        $worker = Get-AtelierProcess $Record.pid
        if (-not (Test-AtelierOwned $worker $Record $Paths)) { throw 'The app process exited or changed before startup completed. See .data\server-error.log.' }
        try {
            $ready = Get-AtelierService $Paths
            if ($ready -and $ready.Id -eq $Record.pid -and (Test-AtelierOwned $ready $Record $Paths)) { return }
        } catch { if ($attempt -eq 119) { throw } }
        Start-Sleep -Milliseconds 250
    }
    throw 'The app is still starting. No extra instance was launched. See .data\server-error.log and retry shortly.'
}
function Invoke-AtelierStart([string]$ProjectRoot, [switch]$NoBrowser, [string]$NodeExecutable) {
    $paths = Get-AtelierPaths $ProjectRoot
    Invoke-AtelierLocked $paths {
        if (-not (Test-Path -LiteralPath $paths.Server -PathType Leaf)) { throw 'The application files are incomplete. Reinstall this app.' }
        $service = Get-AtelierService $paths
        if ($service) {
            if (-not $NoBrowser) { Open-AtelierWindow $paths }
            Write-Output "Atelier is already running: $($paths.Url)"
            return
        }
        $record = Read-AtelierRecord $paths
        if ($record) {
            $worker = Get-AtelierProcess $record.pid
            if ($worker) {
                if (-not (Test-AtelierOwned $worker $record $paths)) { throw 'The saved process now belongs to something else. It was left untouched.' }
                Wait-AtelierReady $paths $record
                if (-not $NoBrowser) { Open-AtelierWindow $paths }
                Write-Output "Atelier is running: $($paths.Url)"
                return
            }
        }
        $node = Resolve-AtelierNode $paths $NodeExecutable
        New-Item -ItemType Directory -Path $paths.Data -Force | Out-Null
        $random = New-Object byte[] 32
        $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
        try { $rng.GetBytes($random) } finally { $rng.Dispose() }
        $token = ([BitConverter]::ToString($random)).Replace('-', '').ToLowerInvariant()
        $workerId = Start-AtelierWorker $paths $node $token
        $worker = Get-AtelierProcess $workerId
        if (-not (Test-AtelierEntry $worker $paths)) { throw 'The new app process could not be verified. It was not stopped automatically.' }
        $record = @{ version = 2; pid = [int]$worker.Id; executable = $node; serverFile = $paths.Server; projectRoot = $paths.Root;
            startTicks = $worker.StartTicks; startedAt = $worker.StartedAt; port = $paths.Port; token = $token }
        Write-AtelierRecord $paths $record
        Wait-AtelierReady $paths $record
        if (-not $NoBrowser) { Open-AtelierWindow $paths }
        Write-Output "Atelier is running in the background: $($paths.Url)"
    }
}
function Request-AtelierStop($Paths, $Record) {
    try {
        return Invoke-RestMethod -Uri ($Paths.Url + '/api/service/stop') -Method Post -Body '{}' -ContentType 'application/json' -Headers @{ Origin = $Paths.Url; 'X-Atelier-Launcher' = $Record.token } -TimeoutSec 15 -MaximumRedirection 0
    } catch { throw 'Safe stop was refused or did not respond. Wait for posting or data collection to finish, then retry. No process was force-stopped.' }
}
function Invoke-AtelierStop([string]$ProjectRoot) {
    $paths = Get-AtelierPaths $ProjectRoot
    Invoke-AtelierLocked $paths {
        $record = Read-AtelierRecord $paths
        if (-not $record) { Write-Output 'No launcher-managed service found. No process was stopped.'; return }
        $worker = Get-AtelierProcess $record.pid
        if (-not $worker) { Remove-Item -LiteralPath $paths.Record -Force; Write-Output 'Atelier is already stopped.'; return }
        if (-not (Test-AtelierOwned $worker $record $paths)) { throw 'The saved process does not belong to this app instance. It was left untouched.' }
        $service = Get-AtelierService $paths
        if (-not $service -or $service.Id -ne $record.pid -or -not (Test-AtelierOwned $service $record $paths)) { throw 'The app is not ready for a safe stop. No process was stopped.' }
        $result = Request-AtelierStop $paths $record
        if (-not $result -or $result.stopping -ne $true) { throw 'The app did not confirm a safe stop. No process was force-stopped.' }
        for ($attempt = 0; $attempt -lt 60; $attempt++) {
            $current = Get-AtelierProcess $record.pid
            if (-not $current -or -not (Test-AtelierOwned $current $record $paths)) {
                Remove-Item -LiteralPath $paths.Record -Force
                Write-Output 'Atelier stopped safely. Your images, drafts, accounts and queue remain saved.'
                return
            }
            Start-Sleep -Milliseconds 250
        }
        throw 'The app is still completing its safe stop. Please wait and retry; no process was force-stopped.'
    }
}
