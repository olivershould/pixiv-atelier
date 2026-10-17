import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
const setup = fileURLToPath(new URL('../Setup-Tagger.ps1', import.meta.url));
const windows = { skip: process.platform !== 'win32' };

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'atelier setup '));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, async python(folder) {
    const executable = path.join(root, folder, 'python.exe');
    await fs.mkdir(path.dirname(executable), { recursive: true });
    await fs.writeFile(executable, 'never executed');
    return executable;
  }, async ps(code) {
    // Load only resolver functions: setup commands and downloads never run.
    const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$tokens = $null; $parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($env:ATELIER_TEST_SETUP, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Setup script parse error' }
foreach ($definition in $ast.FindAll({ param($node); $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $false)) { Invoke-Expression $definition.Extent.Text }
$root = $env:ATELIER_TEST_ROOT
$env:PIXIV_TAGGER_PYTHON = ''
${code}`;
    const result = await run(path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { env: { ...process.env, ATELIER_TEST_ROOT: root, ATELIER_TEST_SETUP: setup }, windowsHide: true, timeout: 15000 });
    return JSON.parse(result.stdout.trim());
  } };
}

test('tagger rejects explicitly selected Codex and WindowsApps Python before execution', windows, async t => {
  const f = await fixture(t);
  for (const folder of ['CodexData', 'codex-runtimes', '.codex', 'WindowsApps']) await f.python(folder);
  const result = await f.ps(`$errors = @(); foreach ($folder in @('CodexData', 'codex-runtimes', '.codex', 'WindowsApps')) { try { Resolve-TaggerPython $root (Join-Path $root ($folder + '\\python.exe')) } catch { $errors += $_.Exception.Message } }; ConvertTo-Json -InputObject $errors -Compress`);
  assert.equal(result.length, 4);
  assert.ok(result.every(error => /independent Python installation/.test(error)));
});

test('tagger skips inherited Codex Python and uses a project runtime', windows, async t => {
  const f = await fixture(t);
  await f.python('CodexData');
  const expected = await f.python('.runtime/python');
  const result = await f.ps(`$env:PIXIV_TAGGER_PYTHON = Join-Path $root 'CodexData\\python.exe'; function Get-TaggerSystemPythonCandidates { throw 'must not discover' }; Resolve-TaggerPython $root '' | ConvertTo-Json -Compress`);
  assert.equal(result, expected);
});

test('tagger reads UTF-8 configured paths and resolves explicit relative paths from the project', windows, async t => {
  const f = await fixture(t);
  const expected = await f.python('独立 Python');
  await fs.mkdir(path.join(f.root, '.data'));
  await fs.writeFile(path.join(f.root, '.data', 'tagger-config.json'), JSON.stringify({ pythonPath: '独立 Python/python.exe' }), 'utf8');
  const result = await f.ps(`function Get-TaggerSystemPythonCandidates { throw 'must not discover' }; @((Resolve-TaggerPython $root ''), (Resolve-TaggerPython $root '独立 Python/python.exe')) | ConvertTo-Json -Compress`);
  assert.deepEqual(result, [expected, expected]);
});

test('tagger skips cached Codex configuration and forbidden PATH entries before independent Python', windows, async t => {
  const f = await fixture(t);
  for (const folder of ['CodexData', 'WindowsApps', 'system-python']) await f.python(folder);
  await fs.mkdir(path.join(f.root, '.data'));
  await fs.writeFile(path.join(f.root, '.data', 'tagger-config.json'), JSON.stringify({ pythonPath: 'CodexData/python.exe' }), 'utf8');
  const result = await f.ps(`$env:PATH = (@('CodexData', 'WindowsApps', 'system-python') | ForEach-Object { Join-Path $root $_ }) -join ';'; Resolve-TaggerPython $root '' | ConvertTo-Json -Compress`);
  assert.equal(result, path.join(f.root, 'system-python', 'python.exe'));
});

test('tagger missing Python explains independent installation without invoking setup', windows, async t => {
  const f = await fixture(t);
  const result = await f.ps(`function Get-TaggerSystemPythonCandidates { return @() }; try { Resolve-TaggerPython $root '' } catch { $_.Exception.Message | ConvertTo-Json -Compress }`);
  assert.match(result, /Independent Python 3.10 or newer was not found/);
});

test('tagger command wrapper forwards arguments, permits its script, and preserves failure status', async () => {
  const cmd = await fs.readFile(new URL('../Setup-Tagger.cmd', import.meta.url), 'utf8');
  assert.match(cmd, /"%SystemRoot%\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe"/);
  assert.match(cmd, /-ExecutionPolicy Bypass -File "%~dp0Setup-Tagger\.ps1" %\*/);
  assert.match(cmd, /set "ATELIER_EXIT=%ERRORLEVEL%"[\r\n]+if "%~1"=="" pause[\r\n]+exit \/b %ATELIER_EXIT%/);
});
