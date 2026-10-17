import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server/index.mjs';

const NOW = '2026-10-04T10:00:00.000Z';
const SIX_HOURS = 6 * 60 * 60 * 1000;
const AVATAR = 'https://i.pximg.net/user-profile/img/2026/10/13/01/02/03/12345678_170.png';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=', 'base64');
PNG.writeUInt32BE(4020414299, 52);
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
function deferred() {
  let resolve;
  return { promise: new Promise(done => { resolve = done; }), resolve: (...args) => resolve(...args) };
}
const tagger = () => ({ status: async () => ({ configured: false, ready: false }), close: async () => {} });

function mockBrowser() {
  const state = { reads: [], submissions: [], records: [], beforeSnapshot: null, beforeReserve: null, avatarUrl: '', snapshotOverride: null };
  function snapshot(account) {
    const records = state.records.filter(record => !record.accountId || record.accountId === account.id);
    return { ok: true, connected: true, premium: true, complete: true, pixivUserId: account.pixivUserId,
      total: records.filter(record => record.status === 'reserved').length,
      reservations: structuredClone(records), avatarUrl: state.avatarUrl, ...state.snapshotOverride };
  }
  return { state, connector: {
    bind: async account => ({ account: { ...account, browser: { targetId: account.id, postingEnabled: false } }, snapshot: snapshot(account) }),
    snapshot: async (account, options) => { state.reads.push({ account: structuredClone(account), options: structuredClone(options) }); await state.beforeSnapshot?.(); return snapshot(account); },
    reserve: async (account, job, files, key, controls) => {
      state.submissions.push({ account: structuredClone(account), job: structuredClone(job), files, key });
      const ordinal = state.submissions.length;
      await state.beforeReserve?.(controls, job, account);
      if (controls?.shouldStop?.()) return { definitive: true, outcome: 'not_uploaded', paused: true, error: '预约已停止，尚未提交。' };
      const reservation = { remoteId: `illust:${50 + ordinal}`, accountId: account.id, jobId: job.id, idempotencyKey: key,
        scheduledAt: job.scheduledAt, status: 'reserved' };
      state.records.push(reservation);
      return { reservation };
    },
    close: async () => {},
  } };
}

async function fixture(t, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pixiv-queue-api-'));
  const browser = mockBrowser();
  const server = await createServer({ dataDir, now: () => new Date(NOW), background: false,
    connectorUrl: '', browserConnector: browser.connector, tagger: tagger(), ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir()));
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  async function request(route, method = 'GET', payload) {
    const response = await fetch(`${base}${route}`, { method, signal: AbortSignal.timeout(3000),
      headers: payload === undefined ? {} : { 'Content-Type': 'application/json' }, body: payload === undefined ? undefined : JSON.stringify(payload) });
    return { status: response.status, data: await response.json() };
  }
  async function completed(runId, afterId) {
    const end = Date.now() + 3000;
    while (Date.now() < end) {
      const { data } = await request('/api/state');
      if (data.queueRun && (!runId || data.queueRun.id === runId) && data.queueRun.id !== afterId && !data.queueRun.running) return data;
      await sleep(5);
    }
    assert.fail('Queue run did not finish in the isolated fixture.');
  }
  return { server, base, dataDir, request, completed, browser };
}

async function liveJob(f) {
  await f.request('/api/mode', 'POST', { mode: 'live' });
  const result = await f.request('/api/accounts', 'POST', { name: '预约测试账号', pixivUserId: '123456' });
  const account = result.data.accounts[0];
  const uploaded = await fetch(`${f.base}/api/files?name=painting.png`, { method: 'POST', body: PNG, headers: { 'Content-Type': 'image/png' } });
  assert.equal(uploaded.status, 201);
  const { file } = await uploaded.json();
  const draft = { accountId: account.id, title: '预约测试作品', files: [file], tags: ['オリジナル'], tagsConfirmed: true,
    timezone: 'Asia/Tokyo', scheduledAt: '2026-10-05T12:00:00.000Z', status: 'queued', content: { aiGenerated: true, rating: 'all', sexualContent: false } };
  const created = await f.request('/api/jobs', 'POST', draft);
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const job = created.data.jobs.find(item => item.id === created.data.createdJobId);
  const bound = await f.request(`/api/accounts/${account.id}/browser`, 'POST', { candidateId: 'fixture-only' });
  assert.equal(bound.status, 200);
  return { account, file, job, draft };
}

test('manual reservation responds asynchronously, exposes progress and coalesces simultaneous clicks', async t => {
  const f = await fixture(t);
  const { account, job } = await liveJob(f);
  const entered = deferred(), release = deferred();
  f.browser.state.beforeSnapshot = async () => { entered.resolve(); await release.promise; };
  let runId;
  try {
    const first = await f.request('/api/queue/start', 'POST', {});
    assert.equal(first.status, 202);
    assert.equal(first.data.queueRun.running, true);
    assert.equal(first.data.queueRun.source, 'manual');
    runId = first.data.queueRun.id;
    await entered.promise;
    const progress = await f.request('/api/state');
    assert.equal(progress.status, 200, 'Progress is readable while the browser operation remains blocked.');
    assert.equal(progress.data.queueRun.id, runId);
    assert.equal(progress.data.queueRun.running, true);
    const duplicates = await Promise.all(Array.from({ length: 4 }, () => f.request('/api/queue/start', 'POST', {})));
    assert.ok(duplicates.every(result => result.status === 202 && result.data.queueRun.id === runId));
    assert.equal(f.browser.state.reads.length, 1);
    assert.equal(f.browser.state.submissions.length, 0);
  } finally { release.resolve(); }
  const finished = await f.completed(runId);
  assert.equal(finished.jobs.find(item => item.id === job.id).status, 'reserved');
  assert.equal(finished.queueRun.reserved, 1);
  assert.equal(finished.queueRun.published, 0);
  assert.equal(finished.queueRun.remaining, 0);
  assert.equal(finished.queueRun.needsReview, 0);
  assert.deepEqual(finished.queueRun.errors, []);
  assert.match(finished.queueRun.message, /已预约 1 件/);
  assert.equal(f.browser.state.submissions.length, 1);
  assert.equal(f.browser.state.submissions[0].account.browser.postingEnabled, true);
  assert.equal(finished.accounts.find(item => item.id === account.id).browser.postingEnabled, false);
  const persisted = JSON.parse(await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8'));
  assert.equal(persisted.states.live.accounts[0].browser.postingEnabled, false, 'A single manual pass never enables stored automatic posting.');
  assert.equal(persisted.states.live.queueRun.running, false);
  assert.equal(finished.queueAutomation.nextCheckAt, '2026-10-04T16:00:00.000Z');
  const again = await f.request('/api/queue/start', 'POST', {});
  const second = await f.completed(again.data.queueRun.id);
  assert.equal(second.queueRun.reserved, 0);
  assert.equal(f.browser.state.submissions.length, 1, 'Rechecking an existing remote reservation does not submit it again.');
});

test('manual reservation preserves the global pause and account-specific pause', async t => {
  const f = await fixture(t);
  const { account, job } = await liveJob(f);
  await f.request('/api/settings', 'PATCH', { queuePaused: true });
  let started = await f.request('/api/queue/start', 'POST', {});
  let finished = await f.completed(started.data.queueRun.id);
  assert.equal(finished.settings.queuePaused, true);
  assert.equal(finished.jobs.find(item => item.id === job.id).status, 'queued');
  assert.match(finished.queueRun.message, /已暂停/);
  assert.equal(f.browser.state.reads.length, 0);
  assert.equal(f.browser.state.submissions.length, 0);
  await f.request('/api/settings', 'PATCH', { queuePaused: false });
  await f.request(`/api/accounts/${account.id}`, 'PATCH', { paused: true });
  started = await f.request('/api/queue/start', 'POST', {});
  finished = await f.completed(started.data.queueRun.id);
  assert.equal(finished.accounts[0].paused, true);
  assert.equal(finished.queueRun.remaining, 1);
  assert.equal(f.browser.state.reads.length, 1);
  assert.equal(f.browser.state.submissions.length, 0);
});

test('a confirmed publication frees capacity and is counted before filling that same pass', async t => {
  const f = await fixture(t);
  const { account, job, draft } = await liveJob(f);
  const prior = { remoteId: 'illust:old', jobId: job.id, scheduledAt: job.scheduledAt, status: 'reserved' };
  f.browser.state.records = [prior, ...Array.from({ length: 9 }, (_, i) => ({ remoteId: `external-${i}`, status: 'reserved', scheduledAt: draft.scheduledAt }))];
  await f.request(`/api/accounts/${account.id}/browser-sync`, 'POST', {});
  const created = await f.request('/api/jobs', 'POST', { ...draft, title: '补位作品', scheduledAt: '2026-10-05T13:00:00.000Z' });
  const waitingId = created.data.createdJobId;
  prior.status = 'published'; prior.publishedAt = NOW; prior.artworkId = '123'; prior.pixivUserId = account.pixivUserId;
  const start = await f.request('/api/queue/start', 'POST', {});
  const finished = await f.completed(start.data.queueRun.id);
  assert.equal(finished.queueRun.published, 1);
  assert.equal(finished.queueRun.reserved, 1);
  assert.equal(finished.queueRun.remaining, 0);
  assert.equal(finished.jobs.find(item => item.id === job.id).status, 'published');
  assert.equal(finished.jobs.find(item => item.id === waitingId).status, 'reserved');
  assert.equal(finished.accounts[0].remote.total, 10);
  assert.equal(f.browser.state.submissions.length, 1);
  assert.equal(f.browser.state.submissions[0].job.id, waitingId);
});

test('uncertain submission is summarized for review and another manual pass never repeats it', async t => {
  const f = await fixture(t);
  const { job } = await liveJob(f);
  f.browser.state.beforeReserve = async () => { throw new Error('Pixiv 上传结果尚未确认'); };
  const start = await f.request('/api/queue/start', 'POST', {});
  const finished = await f.completed(start.data.queueRun.id);
  assert.equal(finished.queueRun.reserved, 0);
  assert.equal(finished.queueRun.needsReview, 1);
  assert.equal(finished.jobs.find(item => item.id === job.id).status, 'needs_review');
  assert.match(finished.queueRun.message, /1 件需核对/);
  const next = await f.request('/api/queue/start', 'POST', {});
  await f.completed(next.data.queueRun.id);
  assert.equal(f.browser.state.submissions.length, 1);
});

test('automatic remote checks wait six hours, run once at the deadline and retain the next deadline', async t => {
  let instant = Date.parse(NOW);
  const f = await fixture(t, { now: () => new Date(instant), background: true, pollInterval: 10 });
  const { account } = await liveJob(f);
  await f.request(`/api/accounts/${account.id}/browser-posting`, 'POST', { enabled: true });
  f.browser.state.reads.length = 0;
  const initial = (await f.request('/api/state')).data;
  assert.equal(initial.queueAutomation.intervalMs, SIX_HOURS);
  instant += SIX_HOURS - 1;
  await sleep(45);
  assert.equal(f.browser.state.reads.length, 0, 'Local timer polling must not poll Pixiv before six hours.');
  assert.equal(f.browser.state.submissions.length, 0);
  instant++;
  const finished = await f.completed();
  assert.equal(finished.queueRun.source, 'automatic');
  assert.equal(finished.queueRun.startedAt, '2026-10-04T16:00:00.000Z');
  assert.equal(finished.queueRun.reserved, 1);
  assert.equal(finished.queueAutomation.nextCheckAt, '2026-10-04T22:00:00.000Z');
  const reads = f.browser.state.reads.length;
  instant += SIX_HOURS - 1;
  await sleep(45);
  assert.equal(f.browser.state.reads.length, reads);
  assert.equal(f.browser.state.submissions.length, 1);
  const persisted = JSON.parse(await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8'));
  assert.equal(persisted.states.live.queueAutomation.nextCheckAt, finished.queueAutomation.nextCheckAt);
});

test('verified account avatar is persisted, served through the local proxy and isolated by workspace', async t => {
  let downloads = 0;
  const f = await fixture(t, { avatarFetch: async (url, options) => {
    downloads++; assert.equal(url, AVATAR); assert.equal(options.headers.Referer, 'https://www.pixiv.net/');
    return new Response(PNG, { headers: { 'Content-Type': 'image/png' } });
  } });
  f.browser.state.avatarUrl = AVATAR;
  const { account } = await liveJob(f);
  const state = (await f.request('/api/state')).data;
  const localUrl = state.accounts[0].avatarUrl;
  assert.ok(localUrl.startsWith(`/api/accounts/${account.id}/avatar?v=`));
  assert.ok(!JSON.stringify(state.accounts).includes('i.pximg.net'));
  const saved = JSON.parse(await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8'));
  assert.equal(saved.states.live.accounts[0].avatarUrl, AVATAR);
  for (let i = 0; i < 2; i++) {
    const response = await fetch(`${f.base}${localUrl}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG);
  }
  assert.equal(downloads, 1, 'Repeated local renders reuse the bounded avatar cache.');
  await f.request('/api/mode', 'POST', { mode: 'demo' });
  assert.equal((await fetch(`${f.base}${localUrl}`)).status, 404);
  await f.request('/api/mode', 'POST', { mode: 'live' });
  assert.equal((await fetch(`${f.base}${localUrl}`)).status, 200);
  await f.request(`/api/accounts/${account.id}`, 'PATCH', { pixivUserId: '654321' });
  const changed = (await f.request('/api/state')).data;
  assert.equal(changed.accounts[0].avatarUrl, undefined, 'Changing the binding removes the former account avatar.');
  assert.equal((await fetch(`${f.base}${localUrl}`)).status, 404);
});

test('wrong-account or failed avatar snapshots cannot replace a previously verified profile', async t => {
  const f = await fixture(t);
  f.browser.state.avatarUrl = AVATAR;
  const { account } = await liveJob(f);
  const alternate = 'https://i.pximg.net/common/images/no_profile.png';
  f.browser.state.avatarUrl = alternate;
  for (const override of [{ pixivUserId: '654321' }, { ok: false }]) {
    f.browser.state.snapshotOverride = override;
    await f.request(`/api/accounts/${account.id}/browser-sync`, 'POST', {});
    const saved = JSON.parse(await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8'));
    assert.equal(saved.states.live.accounts[0].avatarUrl, AVATAR);
  }
});

test('a temporary automatic snapshot timeout retains authorization and retries only six hours later', async t => {
  let instant = Date.parse(NOW), timedOut = false;
  const f = await fixture(t, { now: () => new Date(instant), background: true, pollInterval: 10 });
  const { account } = await liveJob(f);
  await f.request(`/api/accounts/${account.id}/browser-posting`, 'POST', { enabled: true });
  f.browser.state.beforeSnapshot = async () => {
    if (timedOut) throw Object.assign(new Error('Chrome 暂时响应超时'), { code: 'timeout' });
  };
  timedOut = true;
  instant += SIX_HOURS;
  const failed = await f.completed();
  assert.equal(failed.queueRun.source, 'automatic');
  assert.equal(failed.queueRun.errors.length, 1);
  assert.equal(failed.accounts[0].browser.postingEnabled, true, 'A transient network failure must not revoke the user posting preference.');
  assert.equal(failed.accounts[0].remote.syncOk, false);
  assert.equal(f.browser.state.submissions.length, 0);
  const reads = f.browser.state.reads.length;
  timedOut = false;
  instant += SIX_HOURS - 1;
  await sleep(45);
  assert.equal(f.browser.state.reads.length, reads, 'A recovered connection is still checked only at the six-hour deadline.');
  instant++;
  const recovered = await f.completed(undefined, failed.queueRun.id);
  assert.equal(recovered.queueRun.source, 'automatic');
  assert.equal(recovered.queueRun.reserved, 1);
  assert.equal(recovered.accounts[0].browser.postingEnabled, true);
  assert.equal(f.browser.state.submissions.length, 1);
  assert.equal(recovered.queueAutomation.nextCheckAt, '2026-10-05T04:00:00.000Z');
});

for (const code of ['identity_mismatch', 'tab_gone']) {
  test(`automatic ${code} disables posting instead of retrying a stale account binding`, async t => {
    let instant = Date.parse(NOW);
    const f = await fixture(t, { now: () => new Date(instant), background: true, pollInterval: 10 });
    const { account } = await liveJob(f);
    await f.request(`/api/accounts/${account.id}/browser-posting`, 'POST', { enabled: true });
    f.browser.state.beforeSnapshot = async () => { throw Object.assign(new Error('账号绑定需要重新确认'), { code }); };
    instant += SIX_HOURS;
    const failed = await f.completed();
    assert.equal(failed.accounts[0].browser.postingEnabled, false);
    assert.equal(f.browser.state.submissions.length, 0);
    const reads = f.browser.state.reads.length;
    instant += SIX_HOURS;
    await sleep(45);
    assert.equal(f.browser.state.reads.length, reads);
  });
}

function receivedRequestBody(server, pathname) {
  return new Promise(resolve => {
    const observed = req => {
      if (req.url !== pathname) return;
      server.off('request', observed);
      req.on('end', () => setImmediate(resolve));
    };
    server.on('request', observed);
  });
}

async function eventually(predicate) {
  const end = Date.now() + 2500;
  while (Date.now() < end) { if (predicate()) return; await sleep(5); }
  assert.fail('Expected concurrent state was not reached.');
}

test('two same-account windows overlap with a durable slot claim, peak at two, and preserve out-of-order results', async t => {
  const f = await fixture(t); const { draft } = await liveJob(f);
  for (let i = 1; i < 5; i++) await f.request('/api/jobs', 'POST', { ...draft, title: '并行 ' + i, scheduledAt: `2026-10-05T${12 + i}:00:00Z` });
  const gates = [deferred(), deferred()]; let active = 0, peak = 0, entered = 0;
  f.browser.state.beforeReserve = async () => {
    const ordinal = entered++; active++; peak = Math.max(peak, active);
    try { if (ordinal < 2) await gates[ordinal].promise; else await sleep(5); }
    finally { active--; }
  };
  const start = await f.request('/api/queue/start', 'POST', {});
  try {
    await eventually(() => entered === 2);
    const persisted = JSON.parse(await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8'));
    const claims = persisted.states.live.jobs.filter(job => job.status === 'uploading');
    assert.equal(claims.length, 2); assert.ok(claims.every(job => job.idempotencyKey && job.uploadStartedAt));
    const duplicate = await f.request('/api/queue/start', 'POST', {});
    assert.equal(duplicate.data.queueRun.id, start.data.queueRun.id);
    gates[1].resolve();
    await eventually(() => entered === 5 && active === 1);
    assert.equal(active, 1, 'The second worker can finish later jobs while the first remains in preparation.');
  } finally { for (const gate of gates) gate.resolve(); }
  const finished = await f.completed(start.data.queueRun.id);
  assert.equal(peak, 2); assert.equal(finished.jobs.filter(job => job.status === 'reserved').length, 5);
  assert.equal(new Set(finished.jobs.map(job => job.remoteId)).size, 5); assert.equal(finished.queueRun.reserved, 5);
  const saved = JSON.parse(await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8'));
  assert.deepEqual(saved.states.live.jobs.map(job => [job.id, job.status, job.remoteId]), finished.jobs.map(job => [job.id, job.status, job.remoteId]));
  const again = await f.request('/api/queue/start', 'POST', {}); await f.completed(again.data.queueRun.id);
  assert.equal(f.browser.state.submissions.length, 5);
});

test('different accounts run concurrently and each account keeps its own confirmed reservations', async t => {
  const f = await fixture(t); const { draft, account } = await liveJob(f);
  await f.request('/api/jobs', 'POST', { ...draft, title: '第一账号的另一件', scheduledAt: '2026-10-05T13:00:00Z' });
  const added = await f.request('/api/accounts', 'POST', { name: '第二账号', pixivUserId: '654321' });
  const second = added.data.accounts.find(item => item.id !== account.id);
  await f.request(`/api/accounts/${second.id}/browser`, 'POST', { candidateId: 'second' });
  await f.request('/api/jobs', 'POST', { ...draft, accountId: second.id, title: '另一个账号' });
  const release = deferred(); let entered = 0;
  f.browser.state.beforeReserve = async () => { entered++; await release.promise; };
  const start = await f.request('/api/queue/start', 'POST', {});
  try {
    await eventually(() => entered === 2);
    assert.equal(new Set(f.browser.state.submissions.map(call => call.account.id)).size, 2);
  } finally { release.resolve(); }
  const finished = await f.completed(start.data.queueRun.id);
  assert.equal(finished.jobs.filter(job => job.status === 'reserved').length, 3);
  assert.deepEqual(finished.accounts.map(item => item.remote.total), [2, 1]);
  assert.ok(finished.accounts.every(item => item.browser.postingEnabled === false));
});

test('nine external reservations allow only one concurrent local claim and never exceed ten', async t => {
  const f = await fixture(t); const { draft } = await liveJob(f);
  await f.request('/api/jobs', 'POST', { ...draft, title: '等待一' });
  await f.request('/api/jobs', 'POST', { ...draft, title: '等待二' });
  f.browser.state.records = Array.from({ length: 9 }, (_, i) => ({ remoteId: 'external-' + i, status: 'reserved', scheduledAt: draft.scheduledAt }));
  const release = deferred(); let entered = 0;
  f.browser.state.beforeReserve = async () => { entered++; await release.promise; };
  const start = await f.request('/api/queue/start', 'POST', {});
  try { await eventually(() => entered === 1); await sleep(40); assert.equal(entered, 1); }
  finally { release.resolve(); }
  const finished = await f.completed(start.data.queueRun.id);
  assert.equal(finished.accounts[0].remote.total, 10);
  assert.equal(finished.jobs.filter(job => job.status === 'queued').length, 2);
  assert.equal(f.browser.state.submissions.length, 1);
});

test('one uncertain result stops another prepared window on that account while a different account continues', async t => {
  const f = await fixture(t); const { draft, account, job } = await liveJob(f);
  const second = await f.request('/api/jobs', 'POST', { ...draft, title: '已准备未提交', scheduledAt: '2026-10-05T13:00:00Z' });
  const third = await f.request('/api/jobs', 'POST', { ...draft, title: '仍在本地等待', scheduledAt: '2026-10-05T14:00:00Z' });
  const added = await f.request('/api/accounts', 'POST', { name: '不受影响账号', pixivUserId: '654321' });
  const other = added.data.accounts.find(item => item.id !== account.id);
  await f.request(`/api/accounts/${other.id}/browser`, 'POST', { candidateId: 'other' });
  await f.request('/api/jobs', 'POST', { ...draft, accountId: other.id, title: '其他账号继续' });
  let entered = 0;
  f.browser.state.beforeReserve = async (controls, candidate, owner) => {
    if (owner.id !== account.id) return;
    entered++;
    if (candidate.id === job.id) { await eventually(() => entered === 2); throw new Error('点击后的结果未知'); }
    await eventually(() => controls.shouldStop());
  };
  const start = await f.request('/api/queue/start', 'POST', {});
  const finished = await f.completed(start.data.queueRun.id);
  assert.equal(finished.jobs.find(item => item.id === job.id).status, 'needs_review');
  const prepared = finished.jobs.find(item => item.id === second.data.createdJobId);
  assert.equal(prepared.status, 'queued'); assert.equal(prepared.reservationAttempt, 2); assert.equal(prepared.idempotencyKey, undefined);
  assert.equal(finished.jobs.find(item => item.id === third.data.createdJobId).status, 'queued');
  assert.equal(finished.jobs.find(item => item.accountId === other.id).status, 'reserved');
  assert.equal(f.browser.state.submissions.filter(call => call.account.id === account.id).length, 2);
  assert.equal(f.browser.state.records.filter(row => row.accountId === account.id).length, 0);
});

test('global pause during both preparations stops both clicks and preserves every queued work', async t => {
  const f = await fixture(t); const { draft } = await liveJob(f);
  for (let i = 1; i < 3; i++) await f.request('/api/jobs', 'POST', { ...draft, title: '并行暂停 ' + i });
  const release = deferred(); let entered = 0;
  f.browser.state.beforeReserve = async () => { entered++; await release.promise; };
  const start = await f.request('/api/queue/start', 'POST', {}); let pause;
  try {
    await eventually(() => entered === 2);
    const received = receivedRequestBody(f.server, '/api/settings');
    pause = f.request('/api/settings', 'PATCH', { queuePaused: true }); await received;
  } finally { release.resolve(); }
  await pause;
  const finished = await f.completed(start.data.queueRun.id);
  assert.equal(finished.settings.queuePaused, true); assert.equal(finished.jobs.filter(job => job.status === 'queued').length, 3);
  assert.equal(f.browser.state.records.length, 0); assert.equal(f.browser.state.submissions.length, 2);
});

test('external occupation discovered before click returns work to waiting, refreshes capacity, and does not retry this pass', async t => {
  const f = await fixture(t); const { job, draft } = await liveJob(f);
  f.browser.connector.reserve = async (account, candidate, files, key) => {
    f.browser.state.submissions.push({ account, job: candidate, files, key });
    f.browser.state.records = Array.from({ length: 10 }, (_, i) => ({ remoteId: 'external-' + i, status: 'reserved', scheduledAt: draft.scheduledAt }));
    return { definitive: true, outcome: 'not_uploaded', capacityBlocked: true, error: '名额已满' };
  };
  const start = await f.request('/api/queue/start', 'POST', {}); const finished = await f.completed(start.data.queueRun.id);
  const waiting = finished.jobs.find(item => item.id === job.id);
  assert.equal(waiting.status, 'queued'); assert.equal(waiting.reservationAttempt, 2); assert.equal(waiting.idempotencyKey, undefined);
  assert.equal(finished.accounts[0].remote.total, 10); assert.equal(f.browser.state.submissions.length, 1);
  assert.ok(finished.logs.some(row => /预约名额已满，保留待补位/.test(row.message)));
});

test('manual start rejects incomplete, inconsistent, duplicate, and explicitly wrong-account snapshots before claims', async t => {
  for (const override of [{ complete: false }, { complete: undefined }, { total: 1 }, { pixivUserId: '999' },
    { total: 2, reservations: [{ remoteId: 'same', status: 'reserved' }, { remoteId: 'same', status: 'reserved' }] }]) {
    const f = await fixture(t); const { job } = await liveJob(f); f.browser.state.snapshotOverride = override;
    const start = await f.request('/api/queue/start', 'POST', {}); const finished = await f.completed(start.data.queueRun.id);
    assert.equal(finished.jobs.find(item => item.id === job.id).status, 'queued');
    assert.equal(finished.accounts[0].remote.syncOk, false); assert.equal(f.browser.state.submissions.length, 0);
  }
});

for (const pauseScope of ['queue', 'account']) {
  for (const phase of ['initial snapshot', 'first reservation confirmation']) {
    test(`${pauseScope} pause received during ${phase} prevents later pending submissions`, async t => {
      const f = await fixture(t);
      const { account, draft, job } = await liveJob(f);
      const created = await f.request('/api/jobs', 'POST', { ...draft, title: '第二件待预约', scheduledAt: '2026-10-05T13:00:00.000Z' });
      const secondId = created.data.createdJobId;
      const third = await f.request('/api/jobs', 'POST', { ...draft, title: '第三件待预约', scheduledAt: '2026-10-05T14:00:00.000Z' });
      const thirdId = third.data.createdJobId;
      const entered = deferred(), release = deferred();
      const heldRead = phase === 'initial snapshot' ? 1 : 2;
      f.browser.state.beforeSnapshot = async () => {
        if (f.browser.state.reads.length === heldRead) { entered.resolve(); await release.promise; }
      };
      let controls;
      f.browser.state.beforeReserve = receivedControls => { controls = receivedControls; };
      const start = await f.request('/api/queue/start', 'POST', {});
      let pendingPause;
      try {
        await entered.promise;
        const pauseRoute = pauseScope === 'queue' ? '/api/settings' : `/api/accounts/${account.id}`;
        const received = receivedRequestBody(f.server, pauseRoute);
        pendingPause = f.request(pauseRoute, 'PATCH', pauseScope === 'queue' ? { queuePaused: true } : { paused: true });
        await received;
        if (phase === 'first reservation confirmation') {
          assert.equal(typeof controls?.shouldStop, 'function');
          assert.equal(controls.shouldStop(), true, 'The browser callback sees pause intent before the serialized PATCH can finish.');
        }
      } finally { release.resolve(); }
      assert.equal((await pendingPause).status, 200);
      const finished = await f.completed(start.data.queueRun.id);
      assert.ok(phase === 'initial snapshot' ? f.browser.state.submissions.length === 0 : f.browser.state.submissions.length >= 1 && f.browser.state.submissions.length <= 2);
      assert.equal(finished.jobs.find(item => item.id === thirdId).status, 'queued', 'A pause stops work that has not entered either parallel window.');
      assert.ok(['queued', 'reserved'].includes(finished.jobs.find(item => item.id === secondId).status));
      assert.equal(finished.jobs.find(item => item.id === job.id).status, phase === 'initial snapshot' ? 'queued' : 'reserved');
      if (pauseScope === 'queue') assert.equal(finished.settings.queuePaused, true);
      else assert.equal(finished.accounts[0].paused, true);
    });
  }
}
