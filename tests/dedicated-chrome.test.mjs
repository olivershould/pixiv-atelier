import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDedicatedChrome, splitWindowsCommandLine } from '../server/dedicated-chrome.mjs';

const accountA = { id: 'account-a', browser: { userDataDir: 'C:/daily-profile' } };
const accountB = { id: 'account-b' };

async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pixiv-dedicated-chrome-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const executable = path.join(root, 'chrome.exe');
  await fs.writeFile(executable, 'test-only fake executable: never run');
  const dataDir = path.join(root, 'data');
  const processes = [], launches = [], closed = [], opened = [], requests = [];
  let tick = 0, pid = 1000, nextPort = 30000;
  const endpoint = proc => `ws://127.0.0.1:${proc.port}/devtools/browser/test-${proc.pid}`;
  const deps = {
    dataDir, executable, timeoutMs: 50, pollMs: 5,
    now: () => tick, sleep: async ms => { tick += ms; },
    inspectProcesses: async () => processes,
    inspectPortOwner: async port => processes.filter(proc => proc.port === port).map(proc => ({ pid: proc.pid, address: '127.0.0.1' })),
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      const proc = processes.find(item => `http://127.0.0.1:${item.port}/json/version` === url);
      if (!proc) throw new Error('missing endpoint');
      return { ok: true, url, redirected: false, text: async () => JSON.stringify({ Browser: 'Chrome/154.0.8037.99', webSocketDebuggerUrl: endpoint(proc) }) };
    },
    launch: async (exe, args, options) => {
      const profile = args.find(arg => arg.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
      const proc = { pid: ++pid, startedAt: `2026-10-16T00:00:${pid}.000Z`, executable: exe, args: [exe, ...args], port: ++nextPort };
      launches.push({ exe, args, options, proc });
      processes.push(proc);
      await fs.writeFile(path.join(profile, 'DevToolsActivePort'), `${proc.port}\n/devtools/browser/test-${proc.pid}\n`);
      return { pid: proc.pid };
    },
    closeBrowser: async value => {
      closed.push(value);
      const index = processes.findIndex(proc => endpoint(proc) === value);
      assert.notEqual(index, -1, 'only a known managed process can be closed');
      processes.splice(index, 1);
    },
    openLoginWindow: async value => { opened.push(value); },
    ...overrides,
  };
  return { root, dataDir, executable, processes, launches, closed, opened, requests, deps,
    manager: createDedicatedChrome(deps),
    record: account => path.join(dataDir, 'chrome-profiles', account.id, 'managed-process.json'),
  };
}

test('default start is hidden, uses only its isolated directory, and validates loopback ownership', async t => {
  const f = await fixture(t);
  const result = await f.manager.ensure(accountA);
  assert.equal(result.mode, 'headless');
  assert.equal(result.userDataDir, path.join(f.dataDir, 'chrome-profiles', 'account-a', 'user-data'));
  assert.match(result.endpoint, /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/test-/);
  assert.equal(f.launches.length, 1);
  assert.ok(f.launches[0].args.includes('--headless=new'));
  assert.ok(f.launches[0].args.includes('--remote-debugging-address=127.0.0.1'));
  assert.ok(f.launches[0].args.includes('--remote-debugging-port=0'));
  assert.ok(f.launches[0].args.includes('about:blank'));
  assert.equal(f.launches[0].options.windowsHide, true);
  assert.equal(f.launches[0].options.shell, false);
  assert.equal(f.opened.length, 0);
  assert.equal(f.closed.length, 0);
  assert.equal(f.requests[0].options.redirect, 'error');
  assert.equal(f.requests[0].options.method, 'GET');
  assert.deepEqual(await f.manager.status(accountA), { running: true, mode: 'headless' });
  const record = JSON.parse(await fs.readFile(f.record(accountA), 'utf8'));
  assert.equal(record.endpoint, result.endpoint);
  assert.equal(record.pid, f.processes[0].pid);
  assert.ok(record.startedAt);
});

test('two accounts use independent endpoints and never borrow a daily Chrome process', async t => {
  const f = await fixture(t);
  f.processes.push({ pid: 99, executable: f.executable, startedAt: 'daily', args: [f.executable, '--user-data-dir=C:/daily-profile'], port: 9222 });
  const [a, b] = await Promise.all([f.manager.ensure(accountA), f.manager.ensure(accountB)]);
  assert.notEqual(a.endpoint, b.endpoint);
  assert.notEqual(a.userDataDir, b.userDataDir);
  assert.equal(f.processes.find(proc => proc.pid === 99).port, 9222);
  assert.equal(f.launches.length, 2);
  assert.equal(f.closed.length, 0);
});

test('concurrent ensures and a second manager singleflight to one launch; app restart reuses it', async t => {
  const f = await fixture(t);
  const other = createDedicatedChrome(f.deps);
  const results = await Promise.all([f.manager.ensure(accountA), f.manager.ensure(accountA), other.ensure(accountA)]);
  assert.equal(f.launches.length, 1);
  assert.ok(results.every(value => value.endpoint === results[0].endpoint));
  const restarted = createDedicatedChrome(f.deps);
  assert.deepEqual(await restarted.ensure(accountA), results[0]);
  assert.equal(f.launches.length, 1);
});

test('restart recovers a launch interrupted before PID and endpoint were persisted', async t => {
  const f = await fixture(t);
  const session = await f.manager.ensure(accountA);
  const record = JSON.parse(await fs.readFile(f.record(accountA), 'utf8'));
  record.pid = null; record.startedAt = null; record.endpoint = null;
  await fs.writeFile(f.record(accountA), JSON.stringify(record));
  const manager = createDedicatedChrome(f.deps);
  assert.deepEqual(await manager.ensure(accountA), session);
  const recovered = JSON.parse(await fs.readFile(f.record(accountA), 'utf8'));
  assert.equal(recovered.pid, f.processes[0].pid);
  assert.equal(recovered.startedAt, f.processes[0].startedAt);
  assert.equal(recovered.endpoint, session.endpoint);
  assert.equal(f.launches.length, 1);
});

test('explicit login transitions only its own headless profile, reuses visible mode, and can finish in background', async t => {
  const f = await fixture(t);
  const a = await f.manager.ensure(accountA);
  const b = await f.manager.ensure(accountB);
  const visible = await f.manager.showLogin(accountA);
  assert.equal(visible.mode, 'interactive');
  assert.deepEqual(f.closed, [a.endpoint]);
  assert.ok(f.launches.at(-1).args.includes('https://www.pixiv.net/dashboard/works'));
  assert.ok(f.launches.at(-1).args.includes('--new-window'));
  assert.ok(!f.launches.at(-1).args.includes('--headless=new'));
  assert.equal((await f.manager.ensure(accountA)).endpoint, visible.endpoint);
  assert.equal(f.opened.length, 0, 'ordinary ensure must not open or activate a window');
  await f.manager.showLogin(accountA);
  assert.deepEqual(f.opened, [visible.endpoint]);
  assert.equal(f.launches.length, 3);
  const background = await f.manager.finishLogin(accountA);
  assert.equal(background.mode, 'headless');
  assert.deepEqual(f.closed, [a.endpoint, visible.endpoint]);
  assert.equal((await f.manager.ensure(accountB)).endpoint, b.endpoint);
});

test('first explicit interactive request opens one dedicated login window', async t => {
  const f = await fixture(t);
  const result = await f.manager.ensure(accountA, { interactive: true });
  assert.equal(result.mode, 'interactive');
  assert.equal(f.launches.length, 1);
  assert.equal(f.opened.length, 0);
  assert.equal(f.closed.length, 0);
});

test('unsafe identifiers are rejected before creating profile directories', async t => {
  const f = await fixture(t);
  for (const id of ['../daily', '..', '.', 'C:\\daily', 'a/b', 'a\\b', 'a:b', 'a.', 'a ', '', 'CON', 'NUL', 'LPT1', 'x'.repeat(101)]) {
    await assert.rejects(f.manager.ensure({ id }), { code: 'invalid_account' });
  }
  assert.equal(f.launches.length, 0);
  assert.equal(await fs.stat(f.dataDir).then(() => true, () => false), false);
});

test('status for an unused account neither creates directories nor starts Chrome', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.manager.status(accountA), { running: false, mode: null });
  assert.equal(f.launches.length, 0);
  assert.equal(await fs.stat(f.dataDir).then(() => true, () => false), false);
});

test('owned profile with wrong owner token or reused PID is never connected or closed', async t => {
  for (const mutation of ['token', 'startedAt', 'executable', 'address', 'portFlag', 'headless', 'duplicate']) {
    const f = await fixture(t);
    await f.manager.ensure(accountA);
    const proc = f.processes[0];
    if (mutation === 'token') proc.args = proc.args.map(arg => arg.startsWith('--pixiv-publisher-owner=') ? '--pixiv-publisher-owner=other' : arg);
    if (mutation === 'startedAt') proc.startedAt = 'replacement-process';
    if (mutation === 'executable') proc.executable = path.join(f.root, 'other.exe');
    if (mutation === 'address') proc.args = proc.args.map(arg => arg.startsWith('--remote-debugging-address=') ? '--remote-debugging-address=0.0.0.0' : arg);
    if (mutation === 'portFlag') proc.args = proc.args.map(arg => arg.startsWith('--remote-debugging-port=') ? '--remote-debugging-port=9222' : arg);
    if (mutation === 'headless') proc.args = proc.args.filter(arg => arg !== '--headless=new');
    if (mutation === 'duplicate') proc.args.push('--user-data-dir=C:/daily-profile');
    await assert.rejects(f.manager.showLogin(accountA), { code: 'chrome_ownership' }, mutation);
    assert.equal(f.closed.length, 0, mutation);
    assert.equal(f.launches.length, 1, mutation);
  }
});

test('an unrecorded process using the account directory cannot be adopted or killed', async t => {
  const f = await fixture(t);
  const userDataDir = path.join(f.dataDir, 'chrome-profiles', accountA.id, 'user-data');
  f.processes.push({ pid: 50, executable: f.executable, startedAt: 'foreign', args: [f.executable, `--user-data-dir=${userDataDir}`], port: 9222 });
  await assert.rejects(f.manager.ensure(accountA), { code: 'chrome_ownership' });
  assert.equal(f.launches.length, 0);
  assert.equal(f.closed.length, 0);
});

test('stale endpoint pointing at another Chrome process is rejected before HTTP or close', async t => {
  const f = await fixture(t);
  const session = await f.manager.ensure(accountA);
  f.requests.length = 0;
  const other = createDedicatedChrome({ ...f.deps, inspectPortOwner: async () => [{ pid: 333, address: '127.0.0.1' }] });
  await assert.rejects(other.showLogin(accountA), { code: 'chrome_ownership' });
  assert.equal(f.requests.length, 0);
  assert.equal(f.closed.length, 0);
  assert.equal(f.launches.length, 1);
  assert.match(session.endpoint, /127\.0\.0\.1/);
});

test('malformed endpoint, remote host, redirect, mismatched browser path and public listener are rejected', async t => {
  for (const kind of ['file', 'host', 'path', 'redirect', 'listener']) {
    const f = await fixture(t);
    const current = await f.manager.ensure(accountA);
    let manager = f.manager;
    if (kind === 'file') await fs.writeFile(path.join(current.userDataDir, 'DevToolsActivePort'), '9222\nhttps://remote.example');
    else if (kind === 'listener') manager = createDedicatedChrome({ ...f.deps, inspectPortOwner: async () => [{ pid: f.processes[0].pid, address: '0.0.0.0' }] });
    else manager = createDedicatedChrome({ ...f.deps, fetchImpl: async url => ({ ok: true, redirected: kind === 'redirect', url,
      text: async () => JSON.stringify({ Browser: 'Chrome/154', webSocketDebuggerUrl: kind === 'host' ? current.endpoint.replace('127.0.0.1', 'remote.example') : `${current.endpoint}-other` }) }) });
    await assert.rejects(manager.ensure(accountA), { code: 'chrome_ownership' }, kind);
    assert.equal(f.launches.length, 1);
    assert.equal(f.closed.length, 0);
  }
});

test('failed launch is reported safely and a retry can launch without visible fallback', async t => {
  const f = await fixture(t);
  const broken = createDedicatedChrome({ ...f.deps, launch: async () => { throw new Error('private command text and paths'); } });
  await assert.rejects(broken.ensure(accountA), error => error.code === 'chrome_start_failed' && !error.message.includes('private'));
  const result = await f.manager.ensure(accountA);
  assert.equal(result.mode, 'headless');
  assert.equal(f.launches.length, 1);
});

test('missing executable never starts another installed browser or uses a daily profile', async t => {
  const f = await fixture(t);
  const manager = createDedicatedChrome({ ...f.deps, executable: path.join(f.root, 'absent.exe') });
  await assert.rejects(manager.ensure(accountA), { code: 'chrome_missing' });
  assert.equal(f.launches.length, 0);
});

test('readiness timeout holds a live owned process for reuse instead of launching another', async t => {
  const f = await fixture(t);
  const manager = createDedicatedChrome({ ...f.deps, fetchImpl: async () => { throw new Error('not ready'); } });
  await assert.rejects(manager.ensure(accountA), { code: 'chrome_not_ready' });
  assert.equal(f.launches.length, 1);
  const recovered = await f.manager.ensure(accountA);
  assert.equal(recovered.mode, 'headless');
  assert.equal(f.launches.length, 1);
});

test('failed close never launches a second process and leaves the other account intact', async t => {
  const f = await fixture(t);
  await f.manager.ensure(accountA);
  await f.manager.ensure(accountB);
  const manager = createDedicatedChrome({ ...f.deps, closeBrowser: async () => { throw new Error('closed failed'); } });
  await assert.rejects(manager.showLogin(accountA), { code: 'chrome_close_failed' });
  assert.equal(f.launches.length, 2);
  assert.equal(f.processes.length, 2);
});

test('Browser.close acknowledgment without actual process exit cannot start a replacement', async t => {
  const f = await fixture(t);
  await f.manager.ensure(accountA);
  const manager = createDedicatedChrome({ ...f.deps, closeBrowser: async () => {} });
  await assert.rejects(manager.showLogin(accountA), { code: 'chrome_close_failed' });
  assert.equal(f.launches.length, 1);
});

test('Browser.close socket error after send permits switching only once process exit is verified', async t => {
  const f = await fixture(t);
  await f.manager.ensure(accountA);
  let sends = 0;
  class CloseErrorSocket extends EventTarget {
    constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
    send(text) {
      assert.equal(JSON.parse(text).method, 'Browser.close');
      sends++;
      f.processes.length = 0;
      queueMicrotask(() => this.dispatchEvent(new Event('error')));
    }
    close() {}
  }
  const manager = createDedicatedChrome({ ...f.deps, closeBrowser: undefined, WebSocketImpl: CloseErrorSocket });
  assert.equal((await manager.showLogin(accountA)).mode, 'interactive');
  assert.equal(sends, 1);
  assert.equal(f.launches.length, 2);
});

test('Browser.close socket error after send does not allow replacement of a live process', async t => {
  const f = await fixture(t);
  await f.manager.ensure(accountA);
  class CloseErrorSocket extends EventTarget {
    constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
    send() { queueMicrotask(() => this.dispatchEvent(new Event('error'))); }
    close() {}
  }
  const manager = createDedicatedChrome({ ...f.deps, closeBrowser: undefined, WebSocketImpl: CloseErrorSocket });
  await assert.rejects(manager.showLogin(accountA), { code: 'chrome_close_failed' });
  assert.equal(f.launches.length, 1);
  assert.equal(f.processes.length, 1);
});

test('Browser.close connection error before send is still a failure', async t => {
  const f = await fixture(t);
  await f.manager.ensure(accountA);
  class ConnectionErrorSocket extends EventTarget {
    constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('error'))); }
    send() { assert.fail('close must not be sent on an unopened connection'); }
    close() {}
  }
  const manager = createDedicatedChrome({ ...f.deps, closeBrowser: undefined, WebSocketImpl: ConnectionErrorSocket });
  await assert.rejects(manager.showLogin(accountA), { code: 'chrome_close_failed' });
  assert.equal(f.launches.length, 1);
});

test('a stopped dedicated process restarts with its saved profile but a fresh endpoint and token', async t => {
  const f = await fixture(t);
  const first = await f.manager.ensure(accountA);
  const before = JSON.parse(await fs.readFile(f.record(accountA), 'utf8'));
  f.processes.length = 0;
  const second = await f.manager.ensure(accountA);
  const after = JSON.parse(await fs.readFile(f.record(accountA), 'utf8'));
  assert.equal(second.userDataDir, first.userDataDir);
  assert.notEqual(second.endpoint, first.endpoint);
  assert.notEqual(after.ownerToken, before.ownerToken);
  assert.equal(f.closed.length, 0);
});

test('sidecar account mismatch and profile directory junction are refused', async t => {
  const f = await fixture(t);
  await f.manager.ensure(accountA);
  const record = JSON.parse(await fs.readFile(f.record(accountA), 'utf8'));
  record.accountId = 'different-account';
  await fs.writeFile(f.record(accountA), JSON.stringify(record));
  await assert.rejects(f.manager.ensure(accountA), { code: 'chrome_ownership' });
  const outside = path.join(f.root, 'daily-chrome');
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(f.dataDir, 'chrome-profiles', accountB.id), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.manager.ensure(accountB), { code: 'unsafe_profile' });
  assert.deepEqual(await fs.readdir(outside), []);
});

test('Windows command line decoding preserves quoted profile arguments and escaped quotes', () => {
  assert.deepEqual(splitWindowsCommandLine('"C:\\Program Files\\Google\\Chrome\\chrome.exe" --user-data-dir="D:\\A B\\user-data" --headless=new'),
    ['C:\\Program Files\\Google\\Chrome\\chrome.exe', '--user-data-dir=D:\\A B\\user-data', '--headless=new']);
  assert.deepEqual(splitWindowsCommandLine('chrome.exe "unterminated'), []);
  assert.deepEqual(splitWindowsCommandLine('chrome.exe "hello\\\"world"'), ['chrome.exe', 'hello"world']);
});

test('real Windows command-line strings are accepted without requiring injected parsed args', async t => {
  const f = await fixture(t);
  const session = await f.manager.ensure(accountA);
  const proc = f.processes[0];
  proc.commandLine = proc.args.map(arg => /\s/.test(arg) ? `"${arg}"` : arg).join(' ');
  delete proc.args;
  assert.deepEqual(await f.manager.ensure(accountA), session);
  assert.equal(f.launches.length, 1);
});

test('safe status conceals process paths and debugger endpoints on ownership failure', async t => {
  const f = await fixture(t);
  await f.manager.ensure(accountA);
  f.processes[0].startedAt = 'new-process';
  const status = await f.manager.status(accountA);
  assert.equal(status.running, false);
  assert.equal(status.code, 'chrome_ownership');
  assert.ok(!JSON.stringify(status).includes(f.root));
  assert.ok(!JSON.stringify(status).includes('ws://'));
});

test('an unreadable existing PID is not treated as a stopped profile', async t => {
  const f = await fixture(t);
  await f.manager.ensure(accountA);
  delete f.processes[0].args;
  f.processes[0].commandLine = null;
  await assert.rejects(f.manager.ensure(accountA), { code: 'chrome_ownership' });
  assert.equal(f.launches.length, 1);
  assert.equal(f.closed.length, 0);
});
