import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createServer } from '../server/index.mjs';
const token = 'b'.repeat(64);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function deferred() { let resolve; return { promise: new Promise(done => { resolve = done; }), resolve: () => resolve() }; }
async function fixture(t, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'atelier-service-test-'));
  let closed = false, browserClosed = 0, taggerClosed = 0;
  const server = await createServer({ dataDir, background: false, launcherToken: token,
    browserConnector: { close: async () => { browserClosed++; } },
    tagger: { status: async () => ({ ready: false, configured: false }), close: async () => { taggerClosed++; } }, ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  server.once('close', () => { closed = true; });
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    if (!closed) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await server.shutdownComplete;
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const request = async (route, { method = 'GET', body, headers = {} } = {}) => {
    const response = await fetch(`${base}${route}`, { method, signal: AbortSignal.timeout(4000),
      headers: { Origin: base, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body && JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  return { server, base, dataDir, request, closed: () => closed, cleanup: () => ({ browserClosed, taggerClosed }),
    stop: (headers = {}) => request('/api/service/stop', { method: 'POST', body: {}, headers: { 'X-Atelier-Launcher': token, ...headers } }) };
}

test('safe stop requires the launcher token and preserves local-origin protection', async t => {
  const f = await fixture(t);
  for (const headers of [{ 'X-Atelier-Launcher': '' }, { 'X-Atelier-Launcher': 'c'.repeat(64) }, { Origin: 'https://remote.example' }]) {
    assert.equal((await f.stop(headers)).status, 403);
    assert.equal(f.closed(), false);
  }
  assert.equal((await f.request('/api/health')).status, 200);
});

test('a service started without a launcher token cannot be stopped through this endpoint', async t => {
  const f = await fixture(t, { launcherToken: '' });
  assert.equal((await f.stop()).status, 403);
  assert.equal(f.closed(), false);
});

test('idle safe stop persists state, closes resources and returns success without killing a process', async t => {
  const f = await fixture(t);
  await f.request('/api/settings', { method: 'PATCH', body: { queuePaused: true } });
  await sleep(5);
  const closed = once(f.server, 'close');
  const result = await f.stop();
  assert.equal(result.status, 202);
  assert.deepEqual(result.data, { stopping: true });
  await closed; await f.server.shutdownComplete;
  assert.deepEqual(f.cleanup(), { browserClosed: 1, taggerClosed: 1 });
  const saved = JSON.parse(await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8'));
  assert.equal(saved.states.demo.settings.queuePaused, true);
});

test('safe stop refuses an active Pixiv sync and succeeds only after that work completes', async t => {
  const entered = deferred(), release = deferred();
  const snapshot = { ok: true, connected: true, premium: true, complete: true, total: 0, reservations: [] };
  const f = await fixture(t, { browserConnector: {
    bind: async account => ({ account: { ...account, browser: { targetId: 'test', postingEnabled: false } }, snapshot }),
    snapshot: async () => { entered.resolve(); await release.promise; return snapshot; }, close: async () => {},
  } });
  await f.request('/api/mode', { method: 'POST', body: { mode: 'live' } });
  const created = await f.request('/api/accounts', { method: 'POST', body: { name: 'test', pixivUserId: '1234' } });
  await f.request(`/api/accounts/${created.data.accounts[0].id}/browser`, { method: 'POST', body: { candidateId: 'test' } });
  const pending = f.request('/api/pixiv/sync', { method: 'POST', body: {} });
  try {
    await entered.promise;
    assert.equal((await f.stop()).status, 409);
    assert.equal(f.closed(), false);
  } finally { release.resolve(); }
  assert.equal((await pending).status, 200);
  await sleep(10);
  assert.equal((await f.stop()).status, 202);
});

test('failed final persistence leaves service running and permits a later safe retry', async t => {
  const f = await fixture(t);
  const rename = fs.rename;
  let blocked = true;
  t.mock.method(fs, 'rename', async (...args) => {
    if (blocked && args[1] === path.join(f.dataDir, 'state.json')) throw new Error('test persistence unavailable');
    return rename(...args);
  });
  t.mock.method(console, 'error', () => {});
  assert.equal((await f.stop()).status, 500);
  assert.equal(f.closed(), false);
  assert.equal((await f.request('/api/health')).status, 200);
  blocked = false;
  await sleep(5);
  assert.equal((await f.stop()).status, 202);
});

test('client disconnect does not make an unfinished handler safe to stop', async t => {
  const entered = deferred(), release = deferred();
  let reads = 0;
  const f = await fixture(t, { tagger: {
    status: async () => {
      reads++;
      if (reads > 1) { entered.resolve(); await release.promise; }
      return { ready: false, configured: false };
    }, close: async () => {},
  } });
  await f.server.taggerStatusReady;
  const controller = new AbortController();
  const abandoned = fetch(`${f.base}/api/tagger/status`, { signal: controller.signal }).catch(() => null);
  try {
    await entered.promise;
    controller.abort(); await abandoned; await sleep(10);
    assert.equal((await f.stop()).status, 409);
    assert.equal(f.closed(), false);
  } finally { release.resolve(); }
  await sleep(15);
  assert.equal((await f.stop()).status, 202);
});
