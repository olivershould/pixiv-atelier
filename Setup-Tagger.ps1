param([string]$PythonPath)
$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
function Test-IndependentTaggerPython([string]$Value) {
    return $Value -and $Value -notmatch '(?i)(^|[\\/])(?:codex-runtimes|codex-primary-runtime|CodexData|\.codex|WindowsApps)([\\/]|$)'
}
function Resolve-IndependentTaggerPythonPath([string]$ProjectRoot, [string]$Value) {
    if (-not $Value) { return $null }
    $candidate = if ([IO.Path]::IsPathRooted($Value)) { [IO.Path]::GetFullPath($Value) } else { [IO.Path]::GetFullPath((Join-Path $ProjectRoot $Value)) }
    if (-not (Test-IndependentTaggerPython $candidate) -or -not (Test-Path -LiteralPath $candidate -PathType Leaf)) { return $null }
    $candidate = (Resolve-Path -LiteralPath $candidate).ProviderPath
    if (Test-IndependentTaggerPython $candidate) { return $candidate }
    return $null
}
function Get-TaggerSystemPythonCandidates {
    return @(Get-Command python.exe -CommandType Application -All -ErrorAction SilentlyContinue | ForEach-Object { $_.Source })
}
function Resolve-TaggerPython([string]$ProjectRoot, [string]$PythonPath) {
    if ($PythonPath) {
        $selected = Resolve-IndependentTaggerPythonPath $ProjectRoot $PythonPath
        if (-not $selected) { throw 'PythonPath must point to an existing independent Python installation. Codex runtimes and WindowsApps shims are not supported.' }
        return $selected
    }
    foreach ($candidate in @($env:PIXIV_TAGGER_PYTHON, (Join-Path $ProjectRoot '.runtime\python\python.exe'))) {
        $selected = Resolve-IndependentTaggerPythonPath $ProjectRoot $candidate
        if ($selected) { return $selected }
    }
    $configurationPath = Join-Path $ProjectRoot '.data\tagger-config.json'
    if (Test-Path -LiteralPath $configurationPath) {
        $configuration = Get-Content -LiteralPath $configurationPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $selected = Resolve-IndependentTaggerPythonPath $ProjectRoot $configuration.pythonPath
        if ($selected) { return $selected }
    }
    foreach ($candidate in @(Get-TaggerSystemPythonCandidates)) {
        $selected = Resolve-IndependentTaggerPythonPath $ProjectRoot $candidate
        if ($selected) { return $selected }
    }
    throw 'Independent Python 3.10 or newer was not found. Place it in .runtime\python, install it from python.org, or run Setup-Tagger.ps1 -PythonPath <path to python.exe>. Codex runtimes and WindowsApps shims are not used. Relative paths use this project folder.'
}
$PythonPath = Resolve-TaggerPython $projectRoot $PythonPath
& $PythonPath -I -X utf8 -c 'import sys;sys.exit(0 if sys.version_info >= (3,10) else 1)'
if ($LASTEXITCODE -ne 0) { throw 'Python 3.10 or newer is required.' }
Write-Output 'Setting up local image recognition. The first setup downloads a 467 MB model and Python dependencies.'
Write-Output 'Images stay on this computer. Keep this window open until verification completes.'
$setupArguments = @('-I', '-X', 'utf8', (Join-Path $projectRoot 'tagger\setup.py'), '--download-model', '--verify')
$pinsPath = Join-Path $projectRoot '.runtime\tagger\installed-pins.json'
if (-not (Test-Path -LiteralPath $pinsPath)) { $setupArguments += '--install-deps' }
& $PythonPath @setupArguments
if ($LASTEXITCODE -ne 0) { throw 'Local tagger setup failed. The messages above describe the cause; drafts have not been changed.' }
Write-Output 'Local recognition is ready. Open Atelier settings and click the local model status check.'
