param([string]$PythonPath)
$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$configurationPath = Join-Path $projectRoot '.data\tagger-config.json'
if (-not $PythonPath -and (Test-Path -LiteralPath $configurationPath)) {
    $configuration = Get-Content -LiteralPath $configurationPath -Raw | ConvertFrom-Json
    if (Test-Path -LiteralPath $configuration.pythonPath) { $PythonPath = $configuration.pythonPath }
}
if (-not $PythonPath -and $env:PIXIV_TAGGER_PYTHON) { $PythonPath = $env:PIXIV_TAGGER_PYTHON }
if (-not $PythonPath) {
    $pythonCommand = Get-Command python -ErrorAction SilentlyContinue
    if ($pythonCommand -and $pythonCommand.Source -notlike '*\Microsoft\WindowsApps\*') { $PythonPath = $pythonCommand.Source }
}
if (-not $PythonPath -or -not (Test-Path -LiteralPath $PythonPath -PathType Leaf)) {
    throw 'Python 3.10 or newer was not found. Install it from python.org, or run Setup-Tagger.ps1 -PythonPath <absolute path to python.exe>.'
}
& $PythonPath -c 'import sys;sys.exit(0 if sys.version_info >= (3,10) else 1)'
if ($LASTEXITCODE -ne 0) { throw 'Python 3.10 or newer is required.' }
Write-Output 'Setting up local image recognition. The first setup downloads a 467 MB model and Python dependencies.'
Write-Output 'Images stay on this computer. Keep this window open until verification completes.'
$setupArguments = @((Join-Path $projectRoot 'tagger\setup.py'), '--download-model', '--verify')
$pinsPath = Join-Path $projectRoot '.runtime\tagger\installed-pins.json'
if (-not (Test-Path -LiteralPath $pinsPath)) { $setupArguments += '--install-deps' }
& $PythonPath @setupArguments
if ($LASTEXITCODE -ne 0) { throw 'Local tagger setup failed. The messages above describe the cause; drafts have not been changed.' }
Write-Output 'Local recognition is ready. Open Atelier settings and click the local model status check.'
