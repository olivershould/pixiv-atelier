import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server/index.mjs';
import { blankState, createDemoState } from '../server/seed.mjs';

const NOW = '2026-10-16T06:00:00.000Z';
async function fixture(t, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'atelier-dedicated-api-'));
  const live = blankState();
  live.accounts = ['101', '202'].map((user, i) => ({ id: `account-${i}`, pixivUserId: user, name: `Account ${i}`,
    connected: true, premium: true, paused: false, defaultPostingTime: i ? '11:00' : '09:00',
    browser: { targetId: `old-${i}`, postingEnabled: !i }, remote: { syncOk: true, total: 0, reservations: [] } }));
  live.jobs = [{ id: 'draft', accountId: 'account-0', title: 'Keep me', status: 'draft', scheduledAt: '2026-10-17T00:00:00Z', files: [], tags: [] }];
  await fs.writeFile(path.join(dataDir, 'state.json'), JSON.stringify({ version: 1, mode: 'live', states: { live, demo: createDemoState(NOW) }, uploads: {} }));
  const calls = [], mock = { error: null, wrongUser: false, incomplete: false, premium: true, beforeOpen: null };
  const verified = (account, runtimeMode) => {
    if (mock.error) throw Object.assign(new Error(mock.error), { status: 503 });
    const user = mock.wrongUser ? '999' : account.pixivUserId;
    return { account: { ...account, pixivUserId: user, browser: { mode: 'dedicated', targetId: 'dedicated-' + account.id, runtimeMode } },
      snapshot: { ok: true, connected: true, premium: mock.premium, complete: !mock.incomplete, pixivUserId: user, total: 0, reservations: [] } };
  };
  const connector = {
    async openDedicatedLogin(account) { calls.push(['open', account.id]); await mock.beforeOpen?.(account); if (mock.error) throw Object.assign(new Error(mock.error), { status: 503 }); return { mode: 'interactive' }; },
    async verifyDedicated(account) { calls.push(['verify', account.id]); await mock.beforeVerify?.(); return verified(account, 'interactive'); },
    async backgroundDedicated(account) { calls.push(['background', account.id]); return verified(account, 'headless'); },
    async reserve() { assert.fail('Login setup must not submit works'); },
    async analytics() { assert.fail('Login setup must not collect works'); },
    close() {},
  };
  const server = await createServer({ dataDir, background: false, connectorUrl: '', now: () => new Date(NOW),
    tagger: { status: async () => ({ ready: false }), close() {} }, browserConnector: connector, ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (route, payload) => {
    const response = await fetch(base + route, { method: payload === undefined ? 'GET' : 'POST',
      headers: payload === undefined ? {} : { 'Content-Type': 'application/json' }, body: payload === undefined ? undefined : JSON.stringify(payload) });
    return { status: response.status, data: await response.json() };
  };
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await server.analyticsClosed;
    assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir())); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { request, dataDir, calls, mock, live, server };
}
const route = (id, action) => `/api/accounts/account-${id}/browser-dedicated/${action}`;

test('migration preserves account identity, drafts and schedules; setup is idempotent and never launches Chrome', async t => {
  const f = await fixture(t), before = (await f.request('/api/state')).data;
  const { status, data } = await f.request('/api/browser/dedicated/setup', {});
  assert.equal(status, 200); assert.deepEqual(data.jobs, before.jobs); assert.deepEqual(f.calls, []);
  for (let i = 0; i < 2; i++) {
    const account = data.accounts[i]; assert.equal(account.id, before.accounts[i].id); assert.equal(account.pixivUserId, before.accounts[i].pixivUserId);
    assert.equal(account.defaultPostingTime, before.accounts[i].defaultPostingTime);
    assert.equal(account.browser.mode, 'dedicated'); assert.equal(account.browser.targetId, null);
    assert.equal(account.browser.postingEnabled, false); assert.equal(account.browser.resumePostingEnabled, !i);
    assert.equal(account.connected, false); assert.equal(account.browser.loginPending, true);
  }
  await f.request(route(0, 'verify'), {});
  const again = (await f.request('/api/browser/dedicated/setup', {})).data;
  assert.equal(again.accounts[0].browser.postingEnabled, true); assert.equal(again.accounts[0].browser.loginPending, false);
  const persisted = JSON.parse(await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8'));
  assert.deepEqual(persisted.states.live.accounts[0].browser, again.accounts[0].browser);
});

test('opening login persists pending state first and verifies only expected identity before restoring posting', async t => {
  const f = await fixture(t);
  f.mock.beforeOpen = async account => {
    const saved = JSON.parse(await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8')).states.live.accounts[0];
    assert.equal(saved.browser.postingEnabled, false); assert.equal(saved.browser.loginPending, true); assert.equal(saved.browser.targetId, null);
    assert.equal(account.pixivUserId, '101');
  };
  const opened = await f.request(route(0, 'open'), { endpoint: 'http://evil.invalid', profile: 'C:/personal', pixivUserId: '999' });
  assert.equal(opened.status, 200); assert.equal(opened.data.accounts[0].browser.runtimeMode, 'interactive');
  assert.equal(opened.data.accounts[1].browser.mode, undefined);
  f.mock.wrongUser = true;
  const wrong = await f.request(route(0, 'verify'), {}); assert.equal(wrong.status, 409);
  const failed = (await f.request('/api/state')).data.accounts[0];
  assert.equal(failed.pixivUserId, '101'); assert.equal(failed.browser.postingEnabled, false); assert.equal(failed.browser.resumePostingEnabled, true);
  f.mock.wrongUser = false;
  const correct = await f.request(route(0, 'verify'), {}); assert.equal(correct.status, 200);
  assert.equal(correct.data.accounts[0].browser.postingEnabled, true); assert.equal(correct.data.accounts[0].browser.loginPending, false);
  assert.deepEqual(f.calls, [['open', 'account-0'], ['verify', 'account-0'], ['verify', 'account-0']]);
});

test('background failure retains pending state and original permission; retry restores it without enabling read-only account', async t => {
  const f = await fixture(t);
  await f.request('/api/browser/dedicated/setup', {});
  await f.request(route(0, 'verify'), {});
  f.mock.error = 'Profile still closing';
  assert.equal((await f.request(route(0, 'background'), {})).status, 503);
  const pending = (await f.request('/api/state')).data.accounts[0];
  assert.equal(pending.browser.postingEnabled, false); assert.equal(pending.browser.resumePostingEnabled, true); assert.equal(pending.browser.targetId, null);
  f.mock.error = null;
  const background = await f.request(route(0, 'background'), {}); assert.equal(background.status, 200);
  assert.equal(background.data.accounts[0].browser.runtimeMode, 'headless'); assert.equal(background.data.accounts[0].browser.postingEnabled, true);
  await f.request(route(1, 'verify'), {});
  const readonly = await f.request(route(1, 'background'), {});
  assert.equal(readonly.data.accounts[1].browser.postingEnabled, false);
});

test('incomplete verification and missing Premium never enable posting', async t => {
  const f = await fixture(t); await f.request('/api/browser/dedicated/setup', {});
  f.mock.incomplete = true;
  assert.equal((await f.request(route(0, 'verify'), {})).status, 409);
  f.mock.incomplete = false; f.mock.premium = false;
  const verified = await f.request(route(0, 'verify'), {});
  assert.equal(verified.status, 200); assert.equal(verified.data.accounts[0].connected, true);
  assert.equal(verified.data.accounts[0].browser.postingEnabled, false);
});

test('dedicated setup rejects demo mode, external adapters and unselected accounts', async t => {
  const f = await fixture(t);
  assert.equal((await f.request(route(0, 'verify'), {})).status, 409);
  await f.request('/api/mode', { mode: 'demo' });
  assert.equal((await f.request('/api/browser/dedicated/setup', {})).status, 409); assert.deepEqual(f.calls, []);
  const external = await fixture(t, { connectorUrl: 'http://127.0.0.1:9999' });
  assert.equal((await external.request(route(0, 'open'), {})).status, 409); assert.deepEqual(external.calls, []);
});

test('active collection prevents profile switching until the current read finishes', async t => {
  let release, entered;
  const entry = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { browserConnector: {
    async analytics(account) { entered(); await gate; return { pixivUserId: account.pixivUserId, observedAt: NOW,
      complete: true, index: { complete: true, artworkIds: [] }, artworks: [], errors: [] }; }, close() {},
    async openDedicatedLogin() { assert.fail('Cannot change Chrome while collection is running'); },
  } });
  try {
    await f.request('/api/analytics/collect', { accountId: 'account-0' }); await entry;
    assert.equal((await f.request(route(0, 'open'), {})).status, 409);
    assert.equal((await f.request('/api/browser/dedicated/setup', {})).status, 409);
    const account = (await f.request('/api/state')).data.accounts[0];
    assert.equal(account.browser.targetId, 'old-0'); assert.equal(account.browser.postingEnabled, true);
  } finally { release(); await f.server.analytics.collector.idle(); }
});

test('profile switching blocks new collection on another account until verification finishes', async t => {
  const f = await fixture(t);
  await f.request(route(0, 'open'), {});
  let release, entered;
  const entry = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  f.mock.beforeVerify = async () => { entered(); await gate; };
  const verifying = f.request(route(0, 'verify'), {});
  try {
    await entry;
    const collect = await f.request('/api/analytics/collect', { accountId: 'account-1' });
    assert.equal(collect.status, 409); assert.match(collect.data.error, /切换专用 Chrome/);
  } finally { release(); }
  assert.equal((await verifying).status, 200);
});
