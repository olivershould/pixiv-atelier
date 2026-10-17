import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
const helper = fileURLToPath(new URL('../launch/Atelier.Launcher.ps1', import.meta.url));
const windows = { skip: process.platform !== 'win32' };

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'atelier launcher '));
  await fs.mkdir(path.join(root, '.runtime', 'node'), { recursive: true });
  await fs.mkdir(path.join(root, 'server'));
  await fs.writeFile(path.join(root, 'server', 'index.mjs'), '// test only');
  await fs.writeFile(path.join(root, '.runtime', 'node', 'node.exe'), 'never executed');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, async ps(code) {
    const script = `[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)\n. $env:ATELIER_TEST_HELPER\n$paths = Get-AtelierPaths $env:ATELIER_TEST_ROOT\nfunction Get-AtelierNodeVersion { return [version]'24.18.0' }\n${code}`;
    const result = await run(path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { env: { ...process.env, ATELIER_TEST_ROOT: root, ATELIER_TEST_HELPER: helper }, windowsHide: true, timeout: 15000 });
    return JSON.parse(result.stdout.trim());
  } };
}
const fakeProcess = `
$script:worker = @{ Id = 4242; Executable = (Join-Path $paths.Root '.runtime\\node\\node.exe'); StartTicks = '123456'; StartedAt = '2026-10-18T00:00:00Z' }
$script:worker.CommandLine = '"' + $script:worker.Executable + '" "' + $paths.Server + '"'
function Get-AtelierProcess { return $script:worker }
function Get-AtelierHealth { return @{ ok = $true; app = 'pixiv-publisher' } }
function Get-AtelierListeners { return @(@{ Id = 4242; Address = '127.0.0.1' }) }
`;
const saveRecord = `
New-Item -ItemType Directory -Path $paths.Data -Force | Out-Null
$record = @{ version = 2; pid = 4242; executable = $worker.Executable; projectRoot = $paths.Root; serverFile = $paths.Server; startTicks = '123456'; port = 4318; token = ('a' * 64) }
Write-AtelierRecord $paths $record
`;

test('launcher resolves bundled Node first without PATH or Codex lookup', windows, async t => {
  const f = await fixture(t);
  const result = await f.ps(`$env:PATH = ''; Resolve-AtelierNode $paths 'C:\\not-installed\\node.exe' | ConvertTo-Json -Compress`);
  assert.equal(result, path.join(f.root, '.runtime', 'node', 'node.exe'));
});

test('missing runtime gives an independent installation hint and rejects explicit Codex and WindowsApps runtimes', windows, async t => {
  const f = await fixture(t);
  await fs.unlink(path.join(f.root, '.runtime', 'node', 'node.exe'));
  await fs.mkdir(path.join(f.root, 'codex-runtimes'));
  await fs.writeFile(path.join(f.root, 'codex-runtimes', 'node.exe'), 'never executed');
  await fs.mkdir(path.join(f.root, 'WindowsApps'));
  await fs.writeFile(path.join(f.root, 'WindowsApps', 'node.exe'), 'never executed');
  const result = await f.ps(`function Get-AtelierSystemNodeCandidates { return @() }; $errors = @(); try { Resolve-AtelierNode $paths '' } catch { $errors += $_.Exception.Message }; foreach ($directory in @('codex-runtimes', 'WindowsApps')) { try { Resolve-AtelierNode $paths (Join-Path $paths.Root ($directory + '\\node.exe')) } catch { $errors += $_.Exception.Message } }; ConvertTo-Json -InputObject $errors -Compress`);
  assert.match(result[0], /Node.js 22.13 or newer was not found/);
  assert.match(result[1], /not a Codex runtime/);
  assert.match(result[2], /WindowsApps shim/);
});

test('explicit independent Node wins before system discovery when no runtime is bundled', windows, async t => {
  const f = await fixture(t);
  await fs.unlink(path.join(f.root, '.runtime', 'node', 'node.exe'));
  await fs.mkdir(path.join(f.root, '自备 Node'));
  await fs.writeFile(path.join(f.root, '自备 Node', 'node.exe'), 'never executed');
  const result = await f.ps(`function Get-AtelierSystemNodeCandidates { throw 'must not discover' }; Resolve-AtelierNode $paths (Join-Path $paths.Root '自备 Node\\node.exe') | ConvertTo-Json -Compress`);
  assert.equal(result, path.join(f.root, '自备 Node', 'node.exe'));
});

test('fresh clone discovers a suitable system Node after skipping forbidden and old PATH entries', windows, async t => {
  const f = await fixture(t);
  await fs.unlink(path.join(f.root, '.runtime', 'node', 'node.exe'));
  for (const folder of ['CodexData', 'WindowsApps', 'old-node', '独立 Node']) {
    await fs.mkdir(path.join(f.root, folder));
    await fs.writeFile(path.join(f.root, folder, 'node.exe'), 'never executed');
  }
  const result = await f.ps(`
$env:PATH = (@('CodexData', 'WindowsApps', 'old-node', '独立 Node') | ForEach-Object { Join-Path $paths.Root $_ }) -join ';'
$env:ProgramFiles = ''; [Environment]::SetEnvironmentVariable('ProgramFiles(x86)', '', 'Process')
$script:probed = @()
function Get-AtelierNodeVersion { param($Executable); $script:probed += $Executable; if ($Executable -match 'CodexData|WindowsApps') { throw 'forbidden runtime was probed' }; if ($Executable -match 'old-node') { return [version]'22.12.0' }; return [version]'22.13.0' }
$selected = Resolve-AtelierNode $paths ''
@{ selected = $selected; probed = $script:probed } | ConvertTo-Json -Compress`);
  assert.equal(result.selected, path.join(f.root, '独立 Node', 'node.exe'));
  assert.deepEqual(result.probed, ['old-node', '独立 Node'].map(folder => path.join(f.root, folder, 'node.exe')));
});

test('bundled and explicit runtimes fail validation instead of silently switching to a system runtime', windows, async t => {
  const f = await fixture(t);
  const result = await f.ps(`
function Get-AtelierSystemNodeCandidates { throw 'must not discover' }
function Get-AtelierNodeVersion { return [version]'22.12.0' }
$errors = @(); try { Resolve-AtelierNode $paths 'C:\\other\\node.exe' } catch { $errors += $_.Exception.Message }
Remove-Item -LiteralPath (Join-Path $paths.Root '.runtime\\node\\node.exe')
try { Resolve-AtelierNode $paths 'C:\\not-installed\\node.exe' } catch { $errors += $_.Exception.Message }
ConvertTo-Json -InputObject $errors -Compress`);
  assert.match(result[0], /22.13 or newer is required/);
  assert.match(result[1], /full path to an installed node.exe/);
});

test('unusable or outdated discovered runtimes produce a useful missing-runtime error', windows, async t => {
  const f = await fixture(t);
  await fs.unlink(path.join(f.root, '.runtime', 'node', 'node.exe'));
  for (const folder of ['broken', 'old']) {
    await fs.mkdir(path.join(f.root, folder));
    await fs.writeFile(path.join(f.root, folder, 'node.exe'), 'never executed');
  }
  const result = await f.ps(`
function Get-AtelierSystemNodeCandidates { return @((Join-Path $paths.Root 'broken\\node.exe'), (Join-Path $paths.Root 'old\\node.exe')) }
function Get-AtelierNodeVersion { param($Executable); if ($Executable -match 'broken') { throw 'could not start' }; return [version]'22.12.0' }
try { Resolve-AtelierNode $paths '' } catch { $_.Exception.Message | ConvertTo-Json -Compress }`);
  assert.match(result, /Node.js 22.13 or newer was not found/);
});

test('NoBrowser reuses only the exact verified project service without launching or opening a window', windows, async t => {
  const f = await fixture(t);
  const result = await f.ps(`${fakeProcess}
function Start-AtelierWorker { throw 'must not launch' }
function Open-AtelierWindow { throw 'must not open' }
Invoke-AtelierStart $paths.Root -NoBrowser | Out-Null
@{ reused = $true } | ConvertTo-Json -Compress`);
  assert.equal(result.reused, true);
});

test('a healthy service for a different project or public listener is rejected', windows, async t => {
  const f = await fixture(t);
  const result = await f.ps(`${fakeProcess}
$errors = @()
$worker.CommandLine = '"' + $worker.Executable + '" "C:\\another\\server\\index.mjs"'
try { Get-AtelierService $paths } catch { $errors += $_.Exception.Message }
function Get-AtelierListeners { return @(@{ Id = 4242; Address = '0.0.0.0' }) }
try { Get-AtelierService $paths } catch { $errors += $_.Exception.Message }
ConvertTo-Json -InputObject $errors -Compress`);
  assert.equal(result.length, 2);
  assert.ok(result.every(message => /left untouched/.test(message)));
});

test('first launch is recorded and a repeated launch does not create a second process', windows, async t => {
  const f = await fixture(t);
  const result = await f.ps(`${fakeProcess}
$script:launched = 0
function Get-AtelierListeners { if ($script:launched) { return @(@{ Id = 4242; Address = '127.0.0.1' }) }; return @() }
function Start-AtelierWorker { param($Paths, $Executable, $Token); $script:launched++; return 4242 }
function Open-AtelierWindow { throw 'must not open' }
Invoke-AtelierStart $paths.Root -NoBrowser | Out-Null
Invoke-AtelierStart $paths.Root -NoBrowser | Out-Null
$saved = Read-AtelierRecord $paths
@{ launched = $script:launched; version = $saved.version; tokenValid = ($saved.token -match '^[a-f0-9]{64}$'); pid = $saved.pid } | ConvertTo-Json -Compress`);
  assert.deepEqual(result, { launched: 1, version: 2, tokenValid: true, pid: 4242 });
});

test('worker launch hides its window and strips development overrides, then restores parent environment', windows, async t => {
  const f = await fixture(t);
  const result = await f.ps(`
$env:CODEX_TEST = 'private'; $env:OPENAI_API_KEY = 'private'; $env:NODE_OPTIONS = 'bad'; $env:PYTHONPATH = 'bad'; $env:PIXIV_TAGGER_PYTHON = 'bad'; $env:PORT = '9999'
function Start-Process {
 param($FilePath, $ArgumentList, $WorkingDirectory, $WindowStyle, [switch]$PassThru, $RedirectStandardOutput, $RedirectStandardError)
 $script:captured = @{ hidden = ($WindowStyle -eq 'Hidden'); clean = (-not $env:CODEX_TEST -and -not $env:OPENAI_API_KEY -and -not $env:NODE_OPTIONS -and -not $env:PYTHONPATH -and -not $env:PIXIV_TAGGER_PYTHON); port = $env:PORT; token = $env:PIXIV_LAUNCHER_TOKEN; argument = $ArgumentList[0] }
 return @{ Id = 4242 }
}
Start-AtelierWorker $paths (Join-Path $paths.Root '.runtime\\node\\node.exe') ('a' * 64) | Out-Null
$script:captured.restored = ($env:CODEX_TEST -eq 'private' -and $env:OPENAI_API_KEY -eq 'private' -and $env:PORT -eq '9999')
$script:captured | ConvertTo-Json -Compress`);
  assert.equal(result.hidden, true); assert.equal(result.clean, true); assert.equal(result.restored, true);
  assert.equal(result.port, '4318'); assert.equal(result.token, 'a'.repeat(64));
  assert.equal(result.argument, `"${path.join(f.root, 'server', 'index.mjs')}"`);
});

test('safe stop refuses PID reuse and never invokes shutdown for the wrong entry point', windows, async t => {
  const f = await fixture(t);
  const result = await f.ps(`${fakeProcess}${saveRecord}
function Request-AtelierStop { throw 'must not request stop' }
$worker.StartTicks = 'changed'
try { Invoke-AtelierStop $paths.Root } catch { @{ error = $_.Exception.Message } | ConvertTo-Json -Compress }`);
  assert.match(result.error, /does not belong/);
});

test('safe stop requests graceful exit and removes only its local ownership record', windows, async t => {
  const f = await fixture(t);
  const result = await f.ps(`${fakeProcess}${saveRecord}
function Request-AtelierStop { $script:worker = $null; return @{ stopping = $true } }
Invoke-AtelierStop $paths.Root | Out-Null
@{ stopped = (-not (Test-Path -LiteralPath $paths.Record)) } | ConvertTo-Json -Compress`);
  assert.equal(result.stopped, true);
});

test('busy safe-stop refusal retains its record and does not force termination', windows, async t => {
  const f = await fixture(t);
  const result = await f.ps(`${fakeProcess}${saveRecord}
function Request-AtelierStop { throw 'service busy' }
try { Invoke-AtelierStop $paths.Root } catch { @{ error = $_.Exception.Message; retained = (Test-Path -LiteralPath $paths.Record) } | ConvertTo-Json -Compress }`);
  assert.equal(result.error, 'service busy'); assert.equal(result.retained, true);
});

test('entry scripts forward NoBrowser, hide desktop launch, and never force-kill Node', async () => {
  const root = path.dirname(path.dirname(helper));
  const [start, cmd, vbs, stop, shared] = await Promise.all(['Start.ps1', 'Start.cmd', 'Start.vbs', 'Stop.ps1', 'launch/Atelier.Launcher.ps1'].map(file => fs.readFile(path.join(root, file), 'utf8')));
  assert.match(start, /\[switch\]\$NoBrowser/);
  assert.match(cmd, /%\*/);
  assert.match(vbs, /shell\.Run\(command, 0, True\)/);
  assert.match(vbs, /shell\.Popup/);
  assert.doesNotMatch(stop + shared, /Stop-Process|taskkill/i);
  assert.match(shared, /Get-Command node\.exe -CommandType Application -All/);
});
