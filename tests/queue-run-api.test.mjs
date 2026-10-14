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
    return { ok: true, connected: true, premium: true, complete: true, pixivUserId: account.pixivUserId,
      total: state.records.filter(record => record.status === 'reserved').length,
      reservations: structuredClone(state.records), avatarUrl: state.avatarUrl, ...state.snapshotOverride };
  }
  return { state, connector: {
    bind: async account => ({ account: { ...account, browser: { targetId: account.id, postingEnabled: false } }, snapshot: snapshot(account) }),
    snapshot: async (account, options) => { state.reads.push({ account: structuredClone(account), options: structuredClone(options) }); await state.beforeSnapshot?.(); return snapshot(account); },
    reserve: async (account, job, files, key, controls) => {
      state.submissions.push({ account: structuredClone(account), job: structuredClone(job), files, key });
      await state.beforeReserve?.(controls);
      const reservation = { remoteId: `illust:${50 + state.submissions.length}`, jobId: job.id, idempotencyKey: key,
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

for (const pauseScope of ['queue', 'account']) {
  for (const phase of ['initial snapshot', 'first reservation confirmation']) {
    test(`${pauseScope} pause received during ${phase} prevents later pending submissions`, async t => {
      const f = await fixture(t);
      const { account, draft, job } = await liveJob(f);
      const created = await f.request('/api/jobs', 'POST', { ...draft, title: '第二件待预约', scheduledAt: '2026-10-05T13:00:00.000Z' });
      const secondId = created.data.createdJobId;
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
      assert.equal(f.browser.state.submissions.length, phase === 'initial snapshot' ? 0 : 1);
      assert.equal(finished.jobs.find(item => item.id === secondId).status, 'queued');
      assert.equal(finished.jobs.find(item => item.id === job.id).status, phase === 'initial snapshot' ? 'queued' : 'reserved');
      if (pauseScope === 'queue') assert.equal(finished.settings.queuePaused, true);
      else assert.equal(finished.accounts[0].paused, true);
    });
  }
}
