param(
    [Parameter(Mandatory = $true)][string]$Destination,
    [switch]$CreateDesktopShortcut
)
$ErrorActionPreference = 'Stop'
$sourceRoot = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\')
$installRoot = [IO.Path]::GetFullPath($Destination).TrimEnd('\')
if ($installRoot -eq $sourceRoot -or $installRoot.StartsWith($sourceRoot + '\', [StringComparison]::OrdinalIgnoreCase) -or $sourceRoot.StartsWith($installRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Choose a separate installation folder, not the source folder or its parent/child.'
}
if (Test-Path -LiteralPath $installRoot) { throw 'The destination already exists. No existing installation will be overwritten.' }
foreach ($relative in @('.runtime\node\node.exe', '.runtime\python\python.exe', '.runtime\tagger\installed-pins.json', '.data\tagger-config.json', 'Start.vbs', 'Start.ps1', 'Stop.ps1', 'Stop.vbs', 'launch\Atelier.Launcher.ps1', 'server\index.mjs', 'public\index.html', 'tagger\worker.py')) {
    if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot $relative) -PathType Leaf)) { throw "Missing packaged component: $relative" }
}
$service = $null
try { $service = Invoke-RestMethod 'http://127.0.0.1:4318/api/health' -TimeoutSec 2 } catch {}
if ($service) { throw 'Stop the running Atelier service before copying its data.' }
$sourceEntry = Join-Path $sourceRoot 'server\index.mjs'
foreach ($worker in @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'")) {
    if ($worker.CommandLine -and $worker.CommandLine.Replace('/', '\').IndexOf($sourceEntry, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
        throw 'The source service process is still running, even if its health check is unavailable. Stop it before migration.'
    }
}
$profileRoot = Join-Path $sourceRoot '.data\chrome-profiles'
$chromeProcesses = @(Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'")
foreach ($chrome in $chromeProcesses) {
    if (-not $chrome.CommandLine) { throw 'Cannot verify Chrome process ownership. Close Chrome before migration.' }
    if ($chrome.CommandLine.IndexOf($profileRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
        throw 'An Atelier browser profile is still open. Stop its dedicated Chrome before migration.'
    }
}
New-Item -ItemType Directory -Path $installRoot | Out-Null
foreach ($folder in @('server', 'public', 'src', 'tagger', 'launch', 'tests')) {
    $source = Join-Path $sourceRoot $folder
    if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination (Join-Path $installRoot $folder) -Recurse }
}
foreach ($file in @('Start.cmd', 'Start.ps1', 'Start.vbs', 'Stop.cmd', 'Stop.ps1', 'Stop.vbs', 'Setup-Tagger.cmd', 'Setup-Tagger.ps1', 'Install-Standalone.ps1', 'package.json', 'README.md')) {
    $source = Join-Path $sourceRoot $file
    if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination (Join-Path $installRoot $file) }
}
$docsRoot = Join-Path $installRoot 'docs'
New-Item -ItemType Directory -Path $docsRoot | Out-Null
Get-ChildItem -LiteralPath (Join-Path $sourceRoot 'docs') -Filter '*.md' -File | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $docsRoot }
$runtimeRoot = Join-Path $installRoot '.runtime'
New-Item -ItemType Directory -Path $runtimeRoot | Out-Null
foreach ($folder in @('node', 'python', 'tagger')) {
    Copy-Item -LiteralPath (Join-Path $sourceRoot ('.runtime\' + $folder)) -Destination (Join-Path $runtimeRoot $folder) -Recurse
}
$dataRoot = Join-Path $installRoot '.data'
New-Item -ItemType Directory -Path $dataRoot | Out-Null
$dataFiles = @('state.json', 'browser-ledger.json', 'character-memory.json', 'tag-pools.json', 'analytics.sqlite', 'analytics.sqlite-wal', 'analytics.sqlite-shm')
foreach ($file in $dataFiles) {
    $source = Join-Path $sourceRoot ('.data\' + $file)
    if (Test-Path -LiteralPath $source) {
        $target = Join-Path $dataRoot $file
        Copy-Item -LiteralPath $source -Destination $target
        if ((Get-FileHash -LiteralPath $source).Hash -ne (Get-FileHash -LiteralPath $target).Hash) { throw "Copy verification failed: $file" }
    }
}
foreach ($folder in @('uploads', 'models', 'chrome-profiles')) {
    $source = Join-Path $sourceRoot ('.data\' + $folder)
    if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination (Join-Path $dataRoot $folder) -Recurse }
}
$utf8 = New-Object Text.UTF8Encoding($false)
$tagger = Get-Content -LiteralPath (Join-Path $sourceRoot '.data\tagger-config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$tagger.pythonPath = '.runtime/python/python.exe'
$tagger.runtimeDir = '.runtime/tagger'
$tagger.modelDir = '.data/models/wd-swinv2-v3'
[IO.File]::WriteAllText((Join-Path $dataRoot 'tagger-config.json'), ($tagger | ConvertTo-Json -Depth 10), $utf8)
$browserConfig = @{}
$browserConfigSource = Join-Path $sourceRoot '.data\browser-config.json'
if (Test-Path -LiteralPath $browserConfigSource) {
    $oldBrowserConfig = Get-Content -LiteralPath $browserConfigSource -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($oldBrowserConfig.userDataDir) { $browserConfig.userDataDir = $oldBrowserConfig.userDataDir }
}
[IO.File]::WriteAllText((Join-Path $dataRoot 'browser-config.json'), ($browserConfig | ConvertTo-Json), $utf8)
$newProfiles = Join-Path $dataRoot 'chrome-profiles'
if (Test-Path -LiteralPath $newProfiles) {
    foreach ($profile in Get-ChildItem -LiteralPath $newProfiles -Directory) {
        $recordPath = Join-Path $profile.FullName 'managed-process.json'
        if (Test-Path -LiteralPath $recordPath) {
            $record = Get-Content -LiteralPath $recordPath -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($record.accountId -ne $profile.Name) { throw 'Browser profile identity does not match its folder.' }
            $record.userDataDir = Join-Path $profile.FullName 'user-data'
            $record.pid = $null
            $record.startedAt = $null
            $record.endpoint = $null
            [IO.File]::WriteAllText($recordPath, ($record | ConvertTo-Json -Depth 10), $utf8)
        }
    }
}
$manifest = @{ version = 1; installedAt = [DateTime]::UtcNow.ToString('o'); node = '.runtime/node/node.exe'; python = '.runtime/python/python.exe'; data = '.data'; requires = @('Windows', 'Google Chrome', 'Internet for Pixiv') }
[IO.File]::WriteAllText((Join-Path $installRoot 'standalone.json'), ($manifest | ConvertTo-Json -Depth 5), $utf8)
if ($CreateDesktopShortcut) {
    $desktop = [Environment]::GetFolderPath('Desktop')
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut((Join-Path $desktop '画序 · Pixiv 工作台.lnk'))
    $shortcut.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
    $shortcut.Arguments = '"' + (Join-Path $installRoot 'Start.vbs') + '"'
    $shortcut.WorkingDirectory = $installRoot
    $shortcut.Description = '独立启动画序；关闭网页后仍在后台运行。'
    $shortcut.IconLocation = (Join-Path $env:WINDIR 'System32\imageres.dll') + ',15'
    $shortcut.Save()
    $stop = $shell.CreateShortcut((Join-Path $desktop '退出画序后台.lnk'))
    $stop.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
    $stop.Arguments = '"' + (Join-Path $installRoot 'Stop.vbs') + '"'
    $stop.WorkingDirectory = $installRoot
    $stop.Description = '安全停止画序后台服务；作品与账号数据保留。'
    $stop.Save()
}
Write-Output "Standalone Atelier installed at: $installRoot"
Write-Output 'Open Start.vbs to launch. The original application and data have been retained.'
