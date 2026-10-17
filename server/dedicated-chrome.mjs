import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

const execFileAsync = promisify(execFile);
const LOGIN_URL = 'https://www.pixiv.net/dashboard/works';
const operations = new Map();
const errorMessages = {
  invalid_account: '账号标识无效，无法打开投稿专用浏览器。',
  unsafe_profile: '专用浏览器目录校验失败，请检查本地应用数据目录。',
  chrome_missing: '未找到 Google Chrome，请先安装 Chrome。',
  chrome_unsupported: '当前系统不支持自动管理投稿专用 Chrome。',
  chrome_ownership: '无法确认此浏览器属于该投稿账号，已停止连接。',
  chrome_start_failed: '投稿专用 Chrome 启动失败，请重试。',
  chrome_not_ready: '投稿专用 Chrome 尚未准备好，请稍后重试。',
  chrome_close_failed: '专用浏览器尚未退出，暂未切换运行模式。',
  chrome_busy: '专用浏览器正在切换，请稍后重试。',
};

function failure(code) {
  return Object.assign(new Error(errorMessages[code] || errorMessages.chrome_not_ready), { code, status: 503 });
}
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const samePath = (left, right) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();

// Decode Windows command-line arguments without executing any shell text.
export function splitWindowsCommandLine(text) {
  const args = [];
  let value = '', quoted = false, started = false;
  for (let i = 0; i < String(text).length; i++) {
    const ch = text[i];
    if (ch === '\\') {
      let count = 1;
      while (text[i + count] === '\\') count++;
      i += count - 1;
      if (text[i + 1] === '"') {
        value += '\\'.repeat(Math.floor(count / 2));
        if (count % 2) value += '"'; else quoted = !quoted;
        i++;
      } else value += '\\'.repeat(count);
      started = true;
    } else if (ch === '"') { quoted = !quoted; started = true; }
    else if (/\s/.test(ch) && !quoted) {
      if (started) args.push(value);
      value = ''; started = false;
    } else { value += ch; started = true; }
  }
  if (quoted) return [];
  if (started) args.push(value);
  return args;
}

function switches(processInfo) {
  const args = processInfo.args || splitWindowsCommandLine(processInfo.commandLine || '');
  const output = new Map();
  output.profiles = [];
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) continue;
    const equal = args[i].indexOf('=');
    const key = equal < 0 ? args[i] : args[i].slice(0, equal);
    const value = equal < 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : '') : args[i].slice(equal + 1);
    if (output.has(key)) output.ambiguous = true;
    if (key === '--user-data-dir') output.profiles.push(value);
    output.set(key, value);
  }
  return output;
}

async function powershellJson(script) {
  if (process.platform !== 'win32') throw failure('chrome_unsupported');
  const { stdout } = await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    windowsHide: true, timeout: 10000, maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(stdout.trim() || '[]');
}

async function installedChrome() {
  if (process.platform !== 'win32') throw failure('chrome_unsupported');
  const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
  for (const root of roots) {
    const executable = path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe');
    if (await fs.stat(executable).then(info => info.isFile(), () => false)) return executable;
  }
  throw failure('chrome_missing');
}

async function inspectChromeProcesses() {
  const result = await powershellJson("@(Get-CimInstance Win32_Process -Filter \"Name = 'chrome.exe'\" | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; executable = $_.ExecutablePath; commandLine = $_.CommandLine; startedAt = $_.CreationDate.ToUniversalTime().ToString('o') } }) | ConvertTo-Json -Compress");
  return Array.isArray(result) ? result : [result];
}

async function inspectListeningPort(port) {
  // Only a previously validated numeric port is interpolated into this script.
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw failure('chrome_ownership');
  const result = await powershellJson(`@(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ pid = $_.OwningProcess; address = $_.LocalAddress } }) | ConvertTo-Json -Compress`);
  return Array.isArray(result) ? result : [result];
}

async function launchChrome(executable, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, options);
    child.once('error', () => reject(failure('chrome_start_failed')));
    child.once('spawn', () => { child.unref(); resolve({ pid: child.pid }); });
  });
}

async function browserCommand(endpoint, method, params = {}, acceptsDisconnect = false, WebSocketImpl = globalThis.WebSocket) {
  await new Promise((resolve, reject) => {
    const socket = new WebSocketImpl(endpoint);
    let sent = false;
    const timer = setTimeout(() => { try { socket.close(); } catch {} reject(failure('chrome_close_failed')); }, 5000);
    const finish = error => { clearTimeout(timer); try { socket.close(); } catch {} error ? reject(error) : resolve(); };
    socket.addEventListener('open', () => { sent = true; socket.send(JSON.stringify({ id: 1, method, params })); }, { once: true });
    socket.addEventListener('message', event => {
      try { const message = JSON.parse(event.data); if (message.id === 1) finish(message.error ? failure('chrome_close_failed') : null); } catch {}
    });
    socket.addEventListener('close', () => finish(sent && acceptsDisconnect ? null : failure('chrome_close_failed')), { once: true });
    // Chrome can end Browser.close with a socket error instead of a clean close.
    // This only permits stopOwned to check process exit; it does not prove exit.
    socket.addEventListener('error', () => finish(sent && acceptsDisconnect ? null : failure('chrome_close_failed')), { once: true });
  });
}

async function readSmallFile(file, maxBytes = 16384) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw failure('unsafe_profile');
  return fs.readFile(file, 'utf8');
}

function isAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

/** Each account has an isolated, application-owned profile. No daily Chrome
 * paths, cookies, or account-supplied paths are consulted. Dependencies are
 * injectable so tests never need to start Chrome or contact a real endpoint. */
export function createDedicatedChrome({ dataDir, executable, launch = launchChrome,
  inspectProcesses = inspectChromeProcesses, inspectPortOwner = inspectListeningPort,
  fetchImpl = globalThis.fetch, WebSocketImpl = globalThis.WebSocket,
  closeBrowser = endpoint => browserCommand(endpoint, 'Browser.close', {}, true, WebSocketImpl),
  openLoginWindow = endpoint => browserCommand(endpoint, 'Target.createTarget', { url: LOGIN_URL, newWindow: true, background: false }, false, WebSocketImpl), sleep = pause, now = Date.now,
  timeoutMs = 30000, pollMs = 250, resolveExecutable = installedChrome } = {}) {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) throw failure('unsafe_profile');
  const base = path.resolve(dataDir);
  let selectedExecutable;

  function locations(account) {
    const id = account?.id;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(id) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(id)) throw failure('invalid_account');
    const directory = path.join(base, 'chrome-profiles', id);
    return { id, directory, userDataDir: path.join(directory, 'user-data'), recordFile: path.join(directory, 'managed-process.json'), lockFile: path.join(directory, 'manager.lock') };
  }

  async function directories(loc, create) {
    for (const directory of [base, path.join(base, 'chrome-profiles'), loc.directory, loc.userDataDir]) {
      if (create) await fs.mkdir(directory, { recursive: true });
      let info;
      try { info = await fs.lstat(directory); } catch (error) { if (!create && error.code === 'ENOENT') return false; throw error; }
      if (!info.isDirectory() || info.isSymbolicLink()) throw failure('unsafe_profile');
    }
    return true;
  }

  async function getExecutable() {
    if (!selectedExecutable) {
      const value = executable || await resolveExecutable();
      if (typeof value !== 'string' || !path.isAbsolute(value) || !await fs.stat(value).then(info => info.isFile(), () => false)) throw failure('chrome_missing');
      selectedExecutable = path.resolve(value);
    }
    return selectedExecutable;
  }

  async function readRecord(loc) {
    let record;
    try { record = JSON.parse(await readSmallFile(loc.recordFile)); } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw failure(error.code === 'unsafe_profile' ? error.code : 'chrome_ownership');
    }
    if (record.version !== 1 || record.accountId !== loc.id || !samePath(record.userDataDir || '.', loc.userDataDir) ||
      !/^[a-f0-9-]{36}$/.test(record.ownerToken || '') || !['headless', 'interactive'].includes(record.mode) ||
      typeof record.executable !== 'string' || !path.isAbsolute(record.executable) ||
      (record.pid !== null && (!Number.isSafeInteger(record.pid) || record.pid < 1))) throw failure('chrome_ownership');
    return record;
  }

  async function writeRecord(loc, record) {
    const temporary = path.join(loc.directory, `managed-process-${randomUUID()}.tmp`);
    await fs.writeFile(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
    try { await fs.rename(temporary, loc.recordFile); } finally { await fs.unlink(temporary).catch(() => {}); }
  }

  async function matchingProcess(loc, record) {
    const all = await inspectProcesses();
    const profileProcesses = [];
    for (const proc of all) {
      const flags = switches(proc);
      if (flags.has('--type')) continue;
      if (flags.profiles.some(profile => profile && samePath(profile, loc.userDataDir))) profileProcesses.push({ ...proc, flags });
    }
    if (!profileProcesses.length) {
      // A known PID that still exists but cannot be identified is not evidence
      // that the profile is stopped (including unreadable command lines).
      if (record?.pid && all.some(proc => proc.pid === record.pid)) throw failure('chrome_ownership');
      return null;
    }
    if (profileProcesses.length !== 1 || !record) throw failure('chrome_ownership');
    const proc = profileProcesses[0];
    if (proc.flags.ambiguous || !Number.isSafeInteger(proc.pid) || proc.pid < 1 || !proc.startedAt || !proc.executable || !samePath(proc.executable, record.executable) ||
      proc.flags.get('--pixiv-publisher-owner') !== record.ownerToken ||
      proc.flags.get('--remote-debugging-address') !== '127.0.0.1' || proc.flags.get('--remote-debugging-port') !== '0' ||
      (record.mode === 'headless' ? proc.flags.get('--headless') !== 'new' : proc.flags.has('--headless')) ||
      (record.pid !== null && record.pid !== proc.pid) || (record.startedAt && record.startedAt !== proc.startedAt)) throw failure('chrome_ownership');
    return proc;
  }

  async function endpointFor(loc, proc, record) {
    const text = await readSmallFile(path.join(loc.userDataDir, 'DevToolsActivePort'), 1024);
    const lines = text.trim().split(/\r?\n/);
    if (lines.length !== 2 || !/^\d{1,5}$/.test(lines[0]) || Number(lines[0]) < 1 || Number(lines[0]) > 65535 || !/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(lines[1])) throw failure('chrome_ownership');
    const port = Number(lines[0]);
    const endpoint = `ws://127.0.0.1:${port}${lines[1]}`;
    if (record.endpoint && record.endpoint !== endpoint) throw failure('chrome_ownership');
    const owners = await inspectPortOwner(port);
    if (!owners.length || owners.some(owner => owner.pid !== proc.pid || owner.address !== '127.0.0.1')) throw failure('chrome_ownership');
    const url = `http://127.0.0.1:${port}/json/version`;
    const response = await fetchImpl(url, { method: 'GET', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (!response.ok || response.redirected || (response.url && response.url !== url)) throw failure('chrome_ownership');
    const body = await response.text();
    if (body.length > 65536) throw failure('chrome_ownership');
    const version = JSON.parse(body);
    if (version.webSocketDebuggerUrl !== endpoint || !/^(Headless)?Chrome\//.test(version.Browser || '')) throw failure('chrome_ownership');
    return endpoint;
  }

  async function ready(loc, record, wait) {
    const started = now();
    do {
      const proc = await matchingProcess(loc, record);
      if (proc) {
        try { return { proc, endpoint: await endpointFor(loc, proc, record) }; }
        catch (error) { if (['chrome_ownership', 'unsafe_profile'].includes(error.code)) throw error; }
      }
      if (!wait || now() - started >= timeoutMs) return null;
      await sleep(pollMs);
    } while (true);
  }

  async function acquireLock(loc) {
    const started = now();
    const token = randomUUID();
    do {
      try {
        const handle = await fs.open(loc.lockFile, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify({ pid: process.pid, token })); } finally { await handle.close(); }
        return async () => {
          const stored = await readSmallFile(loc.lockFile).then(JSON.parse, () => null);
          if (stored?.token === token) await fs.unlink(loc.lockFile);
        };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let owner;
        try { owner = JSON.parse(await readSmallFile(loc.lockFile)); } catch { throw failure('chrome_busy'); }
        if (!isAlive(owner.pid)) { await fs.unlink(loc.lockFile); continue; }
        if (now() - started >= timeoutMs) throw failure('chrome_busy');
        await sleep(pollMs);
      }
    } while (true);
  }

  async function serialized(account, operation) {
    const loc = locations(account);
    const key = loc.directory.toLowerCase();
    const prior = operations.get(key) || Promise.resolve();
    const result = prior.catch(() => {}).then(async () => {
      await directories(loc, true);
      const release = await acquireLock(loc);
      try { return await operation(loc); } finally { await release(); }
    });
    operations.set(key, result);
    try { return await result; } finally { if (operations.get(key) === result) operations.delete(key); }
  }

  async function stopOwned(loc, record, running) {
    // Recheck immediately before Browser.close; never terminate by image name or
    // kill a PID from stale metadata. The endpoint must still belong to this PID.
    const current = await ready(loc, record, false);
    if (!current || current.proc.pid !== running.proc.pid) throw failure('chrome_close_failed');
    try { await closeBrowser(current.endpoint); } catch { throw failure('chrome_close_failed'); }
    const started = now();
    while (await matchingProcess(loc, record)) {
      if (now() - started >= timeoutMs) throw failure('chrome_close_failed');
      await sleep(pollMs);
    }
  }

  async function start(loc, mode) {
    const executablePath = await getExecutable();
    const record = { version: 1, accountId: loc.id, userDataDir: loc.userDataDir, executable: executablePath,
      ownerToken: randomUUID(), mode, pid: null, startedAt: null, endpoint: null };
    const portFile = path.join(loc.userDataDir, 'DevToolsActivePort');
    try { await readSmallFile(portFile, 1024); await fs.unlink(portFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await writeRecord(loc, record);
    const args = ['--no-first-run', '--no-default-browser-check', '--disable-background-mode',
      '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${loc.userDataDir}`,
      `--pixiv-publisher-owner=${record.ownerToken}`,
      ...(mode === 'headless' ? ['--headless=new', 'about:blank'] : ['--new-window', LOGIN_URL])];
    let child;
    try { child = await launch(executablePath, args, { detached: true, stdio: 'ignore', windowsHide: true, shell: false }); }
    catch { throw failure('chrome_start_failed'); }
    if (!Number.isSafeInteger(child?.pid) || child.pid < 1) throw failure('chrome_start_failed');
    record.pid = child.pid;
    await writeRecord(loc, record);
    const running = await ready(loc, record, true);
    if (!running) throw failure('chrome_not_ready');
    record.startedAt = running.proc.startedAt;
    record.endpoint = running.endpoint;
    await writeRecord(loc, record);
    return { endpoint: running.endpoint, userDataDir: loc.userDataDir, mode };
  }

  async function change(account, requestedMode, forceMode, openExistingWindow = false) {
    return serialized(account, async loc => {
      const record = await readRecord(loc);
      const proc = await matchingProcess(loc, record);
      if (proc) {
        const running = await ready(loc, record, true);
        if (!running) throw failure('chrome_not_ready');
        if (!record.startedAt || !record.endpoint || record.pid === null) {
          record.startedAt = running.proc.startedAt;
          record.pid = running.proc.pid;
          record.endpoint = running.endpoint;
          await writeRecord(loc, record);
        }
        if (!forceMode || record.mode === requestedMode) {
          if (openExistingWindow) await openLoginWindow(running.endpoint);
          return { endpoint: running.endpoint, userDataDir: loc.userDataDir, mode: record.mode };
        }
        await stopOwned(loc, record, running);
      }
      return start(loc, requestedMode);
    });
  }

  return {
    ensure: (account, { interactive = false } = {}) => change(account, interactive ? 'interactive' : 'headless', interactive, interactive),
    showLogin: account => change(account, 'interactive', true, true),
    finishLogin: account => change(account, 'headless', true),
    async status(account) {
      const loc = locations(account);
      try {
        if (!await directories(loc, false)) return { running: false, mode: null };
        const record = await readRecord(loc);
        const running = record && await ready(loc, record, false);
        return { running: Boolean(running), mode: running ? record.mode : null };
      } catch (error) { return { running: false, mode: null, error: errorMessages[error.code] || errorMessages.chrome_not_ready, code: error.code in errorMessages ? error.code : 'chrome_not_ready' }; }
    },
  };
}
