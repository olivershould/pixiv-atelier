import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server/index.mjs';
import { blankState, createDemoState } from '../server/seed.mjs';
import { publicationReviewAccountIds } from '../server/queue-automation.mjs';

const NOW = Date.parse('2026-10-17T00:00:00.000Z');
const SIX_HOURS = 6 * 60 * 60 * 1000;
const iso = value => new Date(value).toISOString();
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
function deferred() { let resolve; return { promise: new Promise(done => { resolve = done; }), resolve: value => resolve(value) }; }
function account(id = 'a', extra = {}) {
  return { id, name: id, pixivUserId: id === 'a' ? '101' : '202', connected: true, premium: true, paused: false,
    browser: { mode: 'dedicated', targetId: `tab-${id}`, postingEnabled: false }, remote: { syncOk: true, complete: true,
      syncedAt: iso(NOW), total: 0, reservations: [] }, ...extra };
}
function job(owner = 'a', extra = {}) {
  return { id: `job-${owner}`, accountId: owner, title: 'Published work', status: 'needs_review', reviewReason: 'reservation_missing_remotely',
    remoteId: `illust:${owner === 'a' ? '501' : '502'}`, idempotencyKey: `attempt-${owner}`, scheduledAt: iso(NOW - 3600000),
    uploadStartedAt: iso(NOW - 7200000), files: [{ id: 'test-file' }], tags: ['オリジナル'], tagsConfirmed: true,
    timezone: 'Asia/Tokyo', content: { type: 'illust', rating: 'all', sexualContent: false, aiGenerated: true, visibility: 'public' }, ...extra };
}

async function fixture(t, { accounts = [account()], jobs = [job()], queuePaused = false, mode = 'live', review, queueNext, background = true } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pixiv-publication-review-'));
  const live = { ...blankState(), accounts, jobs };
  live.settings.queuePaused = queuePaused;
  live.queueAutomation = { intervalMs: SIX_HOURS, nextCheckAt: queueNext || iso(NOW + SIX_HOURS) };
  if (review) live.publicationReviewAutomation = review;
  await fs.writeFile(path.join(dataDir, 'state.json'), JSON.stringify({ version: 1, mode, states: { demo: createDemoState(new Date(NOW)), live }, uploads: {} }));
  let instant = NOW, server, base;
  const reads = [], submissions = [], results = new Map();
  const behavior = { beforeSnapshot: null, activeReads: 0, peakReads: 0 };
  const browserConnector = {
    async snapshot(owner, context) {
      reads.push({ id: owner.id, at: instant, context: structuredClone(context) });
      behavior.activeReads++; behavior.peakReads = Math.max(behavior.peakReads, behavior.activeReads);
      try {
        await behavior.beforeSnapshot?.(owner);
        const value = results.get(owner.id);
        if (value instanceof Error) throw value;
        if (value) return value;
        return { ok: true, connected: true, premium: true, complete: true, pixivUserId: owner.pixivUserId, total: 0,
          reservations: jobs.filter(item => item.accountId === owner.id && item.remoteId).map(item => ({ remoteId: item.remoteId,
            jobId: item.id, idempotencyKey: item.idempotencyKey, scheduledAt: item.scheduledAt, status: 'published',
            publishedAt: item.scheduledAt, artworkId: owner.id === 'a' ? '901' : '902', pixivUserId: owner.pixivUserId })) };
      } finally { behavior.activeReads--; }
    },
    async reserve(...args) { submissions.push(args); throw new Error('Read-only publication checks must never reserve.'); },
    close: async () => {},
  };
  async function start() {
    server = await createServer({ dataDir, now: () => new Date(instant), background, pollInterval: 5,
      browserConnector, connectorUrl: '', tagger: { status: async () => ({ configured: false, ready: false }), close: async () => {} } });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  }
  async function close() {
    if (!server) return;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await server.analyticsClosed;
    server = null;
  }
  await start();
  t.after(async () => {
    await close();
    assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir()));
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  async function request(route = '/api/state', method = 'GET', body) {
    const response = await fetch(`${base}${route}`, { method, signal: AbortSignal.timeout(5000),
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  }
  async function settled(predicate) {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const current = (await request()).data;
      if (predicate(current)) return current;
      await sleep(5);
    }
    assert.fail('Publication review did not settle.');
  }
  return { dataDir, request, settled, reads, submissions, results, behavior,
    advance: milliseconds => { instant += milliseconds; }, restart: async () => { await close(); await start(); } };
}

for (const pause of ['posting_disabled', 'queue_paused', 'account_paused']) {
  test(`${pause}: six-hour review publishes verified work without submitting or changing authorization`, async t => {
    const owner = account('a', { paused: pause === 'account_paused' });
    owner.browser.postingEnabled = pause === 'queue_paused';
    const f = await fixture(t, { accounts: [owner], queuePaused: pause === 'queue_paused' });
    f.advance(SIX_HOURS - 1); await sleep(40);
    assert.equal(f.reads.length, 0);
    f.advance(1);
    const state = await f.settled(value => Boolean(value.publicationReviewAutomation.lastResult));
    assert.equal(state.jobs[0].status, 'published');
    assert.equal(state.jobs[0].artworkId, '901');
    assert.equal(state.accounts[0].paused, owner.paused);
    assert.equal(state.accounts[0].browser.postingEnabled, owner.browser.postingEnabled);
    assert.equal(state.settings.queuePaused, pause === 'queue_paused');
    assert.equal(state.publicationReviewAutomation.lastResult.published, 1);
    assert.equal(state.publicationReviewAutomation.lastResult.source, 'automatic');
    assert.equal(state.publicationReviewAutomation.nextCheckAt, iso(NOW + 2 * SIX_HOURS));
    assert.equal(f.submissions.length, 0);
    assert.equal(f.reads.length, 1);
    assert.equal(f.reads[0].context.jobs[0].id, 'job-a');
  });
}

test('only remote/upload history is eligible; expired local drafts and already-published works do not cause reads', async t => {
  const localJobs = [
    job('a', { id: 'draft', status: 'draft' }),
    job('a', { id: 'expired', status: 'needs_review', reviewReason: 'schedule_expired', remoteId: null, uploadStartedAt: null }),
    job('a', { id: 'never-uploaded', remoteId: null, uploadOutcome: 'not_uploaded' }),
    job('a', { id: 'already-published', status: 'published' }),
    job('a', { id: 'future', status: 'reserved', scheduledAt: iso(NOW + 48 * 3600000) }),
  ];
  assert.deepEqual(publicationReviewAccountIds({ jobs: localJobs }, iso(NOW + SIX_HOURS)), []);
  const f = await fixture(t, { jobs: localJobs });
  f.advance(SIX_HOURS); await sleep(45);
  assert.equal(f.reads.length, 0);
  assert.equal(f.submissions.length, 0);
});

test('a due reserved work and an uncertain uploaded work receive automatic read-only verification', async t => {
  const f = await fixture(t, { accounts: [account(), account('b')], jobs: [job('a', { status: 'reserved' }), job('b', { remoteId: null, uploadOutcome: 'unknown' })] });
  f.advance(SIX_HOURS);
  const state = await f.settled(value => Boolean(value.publicationReviewAutomation.lastResult));
  assert.equal(state.jobs[0].status, 'published');
  assert.equal(state.jobs[1].status, 'needs_review');
  assert.deepEqual(f.reads.map(read => read.id), ['a', 'b']);
  assert.equal(f.submissions.length, 0);
});

test('failed dedicated account does not block another profile and retries only six hours later', async t => {
  const f = await fixture(t, { accounts: [account(), account('b')], jobs: [job(), job('b')] });
  f.results.set('a', Object.assign(new Error('temporary timeout'), { code: 'timeout' }));
  f.advance(SIX_HOURS);
  const first = await f.settled(value => value.publicationReviewAutomation.lastResult?.completedAt === iso(NOW + SIX_HOURS));
  assert.deepEqual(f.reads.map(read => read.id), ['a', 'b']);
  assert.equal(first.jobs[0].status, 'needs_review');
  assert.equal(first.jobs[1].status, 'published');
  assert.equal(first.publicationReviewAutomation.lastResult.failed, 1);
  assert.equal(first.publicationReviewAutomation.lastResult.succeeded, 1);
  f.results.delete('a'); f.advance(SIX_HOURS - 1); await sleep(40);
  assert.equal(f.reads.length, 2);
  f.advance(1);
  const second = await f.settled(value => value.jobs.every(item => item.status === 'published'));
  assert.deepEqual(f.reads.map(read => read.id), ['a', 'b', 'a']);
  assert.equal(second.publicationReviewAutomation.nextCheckAt, iso(NOW + 3 * SIX_HOURS));
  assert.equal(f.submissions.length, 0);
});

test('incomplete or ambiguous publication evidence stays needs_review', async t => {
  const f = await fixture(t, { accounts: [account(), account('b')], jobs: [job(), job('b')] });
  for (const id of ['a', 'b']) f.results.set(id, { ok: true, connected: true, premium: true, complete: id === 'b',
    pixivUserId: id === 'a' ? '101' : '202', total: 0, reservations: [],
    publicationChecks: [{ jobId: `job-${id}`, status: 'pending', reason: 'ambiguous_match' }] });
  f.advance(SIX_HOURS);
  const state = await f.settled(value => Boolean(value.publicationReviewAutomation.lastResult));
  assert.ok(state.jobs.every(item => item.status === 'needs_review'));
  assert.equal(state.publicationReviewAutomation.lastResult.published, 0);
  assert.equal(f.submissions.length, 0);
});

test('manual workspace sync reviews immediately and advances only the review deadline', async t => {
  const f = await fixture(t, { queuePaused: true });
  f.advance(3600000);
  const result = await f.request('/api/pixiv/sync', 'POST', {});
  assert.equal(result.status, 200);
  assert.equal(result.data.jobs[0].status, 'published');
  assert.equal(result.data.publicationReviewAutomation.lastResult.source, 'manual');
  assert.equal(result.data.publicationReviewAutomation.nextCheckAt, iso(NOW + 3600000 + SIX_HOURS));
  assert.equal(result.data.queueAutomation.nextCheckAt, iso(NOW + SIX_HOURS));
  f.advance(SIX_HOURS - 1); await sleep(30);
  assert.equal(f.reads.length, 1);
  assert.equal(f.submissions.length, 0);
});

test('review deadline and last result survive app restart, including failed checks', async t => {
  const f = await fixture(t);
  f.results.set('a', new Error('temporary error'));
  f.advance(SIX_HOURS);
  const first = await f.settled(value => Boolean(value.publicationReviewAutomation.lastResult));
  f.advance(3600000);
  await f.restart();
  const after = (await f.request()).data;
  assert.deepEqual(after.publicationReviewAutomation, first.publicationReviewAutomation);
  await sleep(35);
  assert.equal(f.reads.length, 1);
  f.advance(SIX_HOURS - 3600000 - 1); await sleep(25);
  assert.equal(f.reads.length, 1);
  f.results.delete('a'); f.advance(1);
  await f.settled(value => value.jobs[0].status === 'published');
  assert.equal(f.reads.length, 2);
});

test('the first six-hour deadline is saved at startup and is not postponed by restarting before any check', async t => {
  const f = await fixture(t);
  const initial = (await f.request()).data.publicationReviewAutomation;
  assert.equal(initial.nextCheckAt, iso(NOW + SIX_HOURS));
  const saved = JSON.parse(await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8'));
  assert.deepEqual(saved.states.live.publicationReviewAutomation, initial);
  f.advance(5 * 3600000);
  await f.restart();
  assert.deepEqual((await f.request()).data.publicationReviewAutomation, initial);
  assert.equal(f.reads.length, 0);
  f.advance(3600000);
  await f.settled(value => value.jobs[0].status === 'published');
  assert.equal(f.reads.length, 1);
});

test('all skipped accounts record an attempt and backoff without claiming a successful check', async t => {
  const priorChecked = iso(NOW - SIX_HOURS);
  const f = await fixture(t, { accounts: [account('a', { browser: {} })],
    review: { intervalMs: SIX_HOURS, nextCheckAt: iso(NOW + SIX_HOURS), lastCheckedAt: priorChecked } });
  f.advance(SIX_HOURS);
  const state = await f.settled(value => Boolean(value.publicationReviewAutomation.lastResult));
  const review = state.publicationReviewAutomation;
  assert.equal(f.reads.length, 0);
  assert.equal(review.lastCheckedAt, priorChecked);
  assert.equal(review.lastAttemptAt, iso(NOW + SIX_HOURS));
  assert.equal(review.nextCheckAt, iso(NOW + 2 * SIX_HOURS));
  assert.equal(review.lastResult.skipped, 1);
  assert.equal(review.lastResult.checked, false);
  assert.match(review.lastResult.message, /未完成/);
  assert.match(state.logs[0].message, /未完成核对/);
  f.advance(SIX_HOURS - 1); await sleep(35);
  assert.equal((await f.request()).data.publicationReviewAutomation.lastAttemptAt, review.lastAttemptAt);
  assert.equal(f.submissions.length, 0);
});

test('manual sync with no accounts has no successful check timestamp', async t => {
  const f = await fixture(t, { accounts: [], jobs: [] });
  const { data, status } = await f.request('/api/pixiv/sync', 'POST', {});
  assert.equal(status, 200);
  assert.equal(data.publicationReviewAutomation.lastCheckedAt, undefined);
  assert.equal(data.publicationReviewAutomation.lastAttemptAt, iso(NOW));
  assert.equal(data.publicationReviewAutomation.lastResult.checked, false);
  assert.equal(f.reads.length, 0);
});

test('a first-persist failure before snapshot backs off without recording a successful check', async t => {
  const f = await fixture(t);
  const originalRename = fs.rename;
  let failures = 0;
  t.mock.method(fs, 'rename', async (...args) => {
    if (args[1] === path.join(f.dataDir, 'state.json') && failures === 0) {
      failures++;
      throw Object.assign(new Error('test-only first persist failure'), { code: 'EACCES' });
    }
    return originalRename(...args);
  });
  f.advance(SIX_HOURS);
  const state = await f.settled(value => Boolean(value.publicationReviewAutomation.lastResult));
  const review = state.publicationReviewAutomation;
  assert.equal(failures, 1);
  assert.equal(f.reads.length, 0);
  assert.equal(review.lastCheckedAt, undefined);
  assert.equal(review.lastAttemptAt, iso(NOW + SIX_HOURS));
  assert.equal(review.nextCheckAt, iso(NOW + 2 * SIX_HOURS));
  assert.equal(review.lastResult.checked, false);
  assert.equal(review.lastResult.failed, 1);
  assert.match(review.lastResult.error, /first persist failure/);
  assert.match(state.logs[0].message, /未正常完成/);
  assert.equal(state.pixivSync.completedAt, iso(NOW + SIX_HOURS));
  const saved = JSON.parse(await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8'));
  assert.deepEqual(saved.states.live.publicationReviewAutomation, review);
  f.advance(SIX_HOURS - 1); await sleep(35);
  assert.equal(f.reads.length, 0);
  f.advance(1);
  const completed = await f.settled(value => value.jobs[0].status === 'published');
  assert.equal(completed.publicationReviewAutomation.lastCheckedAt, iso(NOW + 2 * SIX_HOURS));
  assert.equal(f.reads.length, 1);
});

test('a queue snapshot failure keeps the previous successful review timestamp', async t => {
  const owner = account(); owner.browser.postingEnabled = true;
  const priorChecked = iso(NOW - SIX_HOURS);
  const f = await fixture(t, { accounts: [owner], review: { nextCheckAt: iso(NOW + SIX_HOURS), lastCheckedAt: priorChecked } });
  f.results.set('a', new Error('snapshot unavailable'));
  f.advance(SIX_HOURS);
  const state = await f.settled(value => value.queueRun && !value.queueRun.running);
  assert.equal(f.reads.length, 1);
  assert.equal(state.publicationReviewAutomation.lastCheckedAt, priorChecked);
  assert.equal(state.publicationReviewAutomation.lastAttemptAt, iso(NOW + SIX_HOURS));
  assert.equal(state.publicationReviewAutomation.lastResult.checked, false);
  assert.equal(state.publicationReviewAutomation.lastResult.source, 'automatic_queue');
  assert.equal(state.publicationReviewAutomation.nextCheckAt, iso(NOW + 2 * SIX_HOURS));
  assert.equal(f.submissions.length, 0);
});

test('a paused manual queue run does not move the review deadline without reading a snapshot', async t => {
  const f = await fixture(t, { queuePaused: true });
  f.advance(3600000);
  const started = await f.request('/api/queue/start', 'POST', {});
  assert.equal(started.status, 202);
  const stopped = await f.settled(value => value.queueRun && !value.queueRun.running);
  assert.equal(stopped.publicationReviewAutomation.nextCheckAt, iso(NOW + SIX_HOURS));
  assert.equal(stopped.publicationReviewAutomation.lastResult, undefined);
  assert.equal(f.reads.length, 0);
  f.advance(SIX_HOURS - 3600000);
  await f.settled(value => value.jobs[0].status === 'published');
  assert.equal(f.reads.length, 1);
});

test('automatic review coalesces repeated timer ticks and rejects duplicate manual sync without a second read', async t => {
  const f = await fixture(t);
  const entered = deferred(), release = deferred();
  f.behavior.beforeSnapshot = async () => { entered.resolve(); await release.promise; };
  f.advance(SIX_HOURS);
  try {
    await entered.promise; await sleep(35);
    const duplicate = await f.request('/api/pixiv/sync', 'POST', {});
    assert.equal(duplicate.status, 409);
    assert.equal(f.reads.length, 1);
    assert.equal(f.behavior.peakReads, 1);
  } finally { release.resolve(); }
  await f.settled(value => value.jobs[0].status === 'published');
  assert.equal(f.reads.length, 1);
  assert.equal(f.submissions.length, 0);
});

test('a manual queue run requested during review waits until the read-only pass finishes', async t => {
  const f = await fixture(t);
  const entered = deferred(), release = deferred();
  f.behavior.beforeSnapshot = async () => { entered.resolve(); await release.promise; };
  f.advance(SIX_HOURS);
  try {
    await entered.promise;
    const requested = await f.request('/api/queue/start', 'POST', {});
    assert.equal(requested.status, 202);
    await sleep(30);
    assert.equal(f.reads.length, 1);
    assert.equal(f.submissions.length, 0);
  } finally { release.resolve(); }
  const state = await f.settled(value => value.queueRun && !value.queueRun.running);
  assert.equal(state.jobs[0].status, 'published');
  assert.equal(f.behavior.peakReads, 1);
  assert.equal(f.reads.length, 1, 'Finished publication leaves no queue work for another remote read.');
});

test('a regular queue run due together performs the shared review once without postponing its cadence', async t => {
  const owner = account(); owner.browser.postingEnabled = true;
  const f = await fixture(t, { accounts: [owner] });
  f.advance(SIX_HOURS);
  const state = await f.settled(value => value.queueRun && !value.queueRun.running);
  assert.equal(state.jobs[0].status, 'published');
  assert.equal(state.queueRun.source, 'automatic');
  assert.equal(state.publicationReviewAutomation.lastResult.source, 'automatic_queue');
  assert.equal(state.queueAutomation.nextCheckAt, iso(NOW + 2 * SIX_HOURS));
  assert.equal(state.publicationReviewAutomation.nextCheckAt, iso(NOW + 2 * SIX_HOURS));
  await sleep(35);
  assert.equal(f.reads.length, 1);
  assert.equal(f.submissions.length, 0);
});

test('review due before the queue does not move the posting deadline', async t => {
  const owner = account(); owner.browser.postingEnabled = true;
  const f = await fixture(t, { accounts: [owner], queueNext: iso(NOW + 2 * SIX_HOURS) });
  f.advance(SIX_HOURS);
  const state = await f.settled(value => Boolean(value.publicationReviewAutomation.lastResult));
  assert.equal(state.queueAutomation.nextCheckAt, iso(NOW + 2 * SIX_HOURS));
  assert.equal(state.publicationReviewAutomation.lastResult.source, 'automatic');
  assert.equal(state.queueRun, undefined);
  assert.equal(f.submissions.length, 0);
});

test('demo mode never runs a live publication review', async t => {
  const f = await fixture(t, { mode: 'demo' });
  f.advance(SIX_HOURS); await sleep(40);
  assert.equal(f.reads.length, 0);
  assert.equal(f.submissions.length, 0);
});
