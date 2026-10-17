import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAnalyticsStore } from '../server/analytics.mjs';
import { analyticsAccountKey, createAnalyticsCollector } from '../server/analytics-collector.mjs';

const BASE = '2026-10-01T00:00:00.000Z';
const at = hours => new Date(Date.parse(BASE) + hours * 3600000).toISOString();
const account = (id, pixivUserId) => ({ id, pixivUserId, name: id, browser: { targetId: `${id}-tab` } });
const a = account('a', '101'), b = account('b', '102');
const row = (id, userId = '101', changes = {}) => ({ artworkId: String(id), userId, title: `Work ${id}`, createDate: BASE,
  tags: ['tag'], viewCount: 100, bookmarkCount: 10, likeCount: 5, ...changes });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('bulk pages avoid per-work archive requests, recover shifted rows, and calibrate recent publication dates', async t => {
  const f = fixture(t, { initialHours: 8, handler: (current, input, { response }) => {
    const provisional = id => row(id, current.pixivUserId, { createDate: at(1), publicationTimeVerified: false, createDateSource: 'pixiv-management-thumbnail' });
    if (input.includeIndex) return response(current, { index: { complete: true, artworkIds: ['1', '2', '3', '4'] },
      artworks: ['1', '2'].map(provisional), fetchRanges: [[2, 2]], account: { views: 1000, followers: 50 } });
    if (input.bulk) return response(current, { artworks: [provisional('3')], complete: false, page: { offset: 2, count: 2 } });
    return response(current, { artworks: input.artworkIds.map(id => row(id, current.pixivUserId, { createDate: BASE, publicationTimeVerified: true })), attemptedArtworkIds: input.artworkIds });
  } });
  await f.start();
  assert.equal(f.calls.filter(call => call.input.bulk).length, 2);
  assert.equal(f.calls.filter(call => call.input.artworkIds?.includes('4')).length, 1, 'missing indexed row recovered individually');
  assert.equal(f.store.status().workCount, 4);
  const rows = f.store.report({ accountId: analyticsAccountKey(a) }).rows;
  assert.ok(rows.every(work => work.publicationTimeVerified === true && work.publishedAt === BASE));
  assert.equal(f.store.unverifiedRecentWorks({ accountId: analyticsAccountKey(a), since: BASE }).length, 0);
});

test('bulk rate limiting persists its page cursor and resumes without fetching the archive index again', async t => {
  let limited = true;
  const f = fixture(t, { initialHours: 8, handler: (current, input, { response }) => {
    if (input.includeIndex) return response(current, { index: { complete: true, artworkIds: ['1', '2'] },
      artworks: [row('1')], fetchRanges: [[1, 1]] });
    if (input.bulk && limited) return response(current, { rateLimited: true, retryAfterSeconds: 120 });
    return response(current, { artworks: [row('2')], complete: true });
  } });
  await f.start();
  assert.equal(f.collector.status().accounts[0].remainingWorks, 1);
  await f.restart(); await f.start(); assert.equal(f.calls.length, 2);
  limited = false; f.setTime(8 + 3 / 60); await f.start();
  assert.equal(f.calls.filter(call => call.input.includeIndex).length, 1);
  assert.equal(f.store.status().workCount, 2);
});

function fixture(t, { accounts = [a], initialHours = 0, handler, seeds = [], characters = [], trackCompletions = false } = {}) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'pixiv-analytics-collector-'));
  let hours = initialHours, store, collector;
  const context = { mode: 'live', accounts: structuredClone(accounts), contextVersion: 1 }, calls = [], completions = [];
  const response = (current, value = {}) => ({ pixivUserId: current.pixivUserId, observedAt: at(hours), artworks: [], errors: [], ...value });
  const fetchAnalytics = async (current, input) => {
    calls.push({ accountId: current.id, pixivUserId: current.pixivUserId, input: structuredClone(input) });
    if (handler) return handler(current, input, { response, calls, setTime: value => { hours = value; }, context });
    return response(current, input.includeIndex ? { index: { complete: true, artworkIds: [] }, account: { views: 0, followers: 0 } }
      : { artworks: input.artworkIds.map(id => row(id, current.pixivUserId)), attemptedArtworkIds: input.artworkIds });
  };
  const open = () => {
    store = createAnalyticsStore({ dataDir, now: () => new Date(at(hours)) });
    if (trackCompletions) {
      const completePeriodicRun = store.completePeriodicRun?.bind(store);
      store.completePeriodicRun = (accountId, input) => {
        completions.push({ accountId, input: structuredClone(input), recordedSamples: store.status({ accountId }).sampleCount });
        return completePeriodicRun?.(accountId, input);
      };
    }
    collector = createAnalyticsCollector({ store, getContext: () => context, fetchAnalytics,
      getSeedWorks: async current => typeof seeds === 'function' ? seeds(current) : seeds,
      getCharacters: async () => characters, now: () => new Date(at(hours)), batchDelayMs: 0 });
  };
  open();
  t.after(async () => { await collector.close(); store.close(); rmSync(dataDir, { recursive: true, force: true }); });
  return { context, calls, completions, get store() { return store; }, get collector() { return collector; }, setTime(value) { hours = value; },
    async start(options) { collector.start(options); await collector.idle(); return collector.status(); },
    async restart() { await collector.close(); store.close(); open(); } };
}

test('periodic completion summary waits for the final page and records the full cycle exactly once', async t => {
  const entered = deferred(), finalPage = deferred();
  const f = fixture(t, { initialHours: 1, trackCompletions: true, handler: async (current, input, { response }) => {
    if (input.includeIndex) return response(current, { index: { complete: true, artworkIds: ['1', '2'] },
      artworks: [row('1')], fetchRanges: [[1, 1]], account: { views: 1000, followers: 50 } });
    entered.resolve(); await finalPage.promise;
    return response(current, { artworks: [row('2')], complete: true });
  } });
  f.collector.start(); await entered.promise;
  const cycleId = f.store.getMeta('collector:v1').accounts[analyticsAccountKey(a)].cycle.id;
  assert.equal(f.store.status().sampleCount, 1);
  assert.deepEqual(f.completions, [], 'a partial archive must not become a completed daily baseline');
  f.setTime(1 + 1 / 60); finalPage.resolve(); await f.collector.idle();
  assert.deepEqual(f.completions, [{ accountId: analyticsAccountKey(a), input: {
    runId: cycleId, completedAt: at(1 + 1 / 60), expectedWorkCount: 2,
  }, recordedSamples: 2 }]);
  await f.start();
  assert.equal(f.completions.length, 1, 'an idle scheduler must not commit the completed cycle twice');
});

test('interruption and persisted rate-limit waits never complete a cycle before its remaining page is saved', async t => {
  const entered = deferred(), interruptedPage = deferred();
  let phase = 'interrupt';
  const f = fixture(t, { initialHours: 1, trackCompletions: true, handler: async (current, input, { response }) => {
    if (input.includeIndex) return response(current, { index: { complete: true, artworkIds: ['1', '2'] }, artworks: [row('1')], fetchRanges: [[1, 1]] });
    if (phase === 'interrupt') { entered.resolve(); await interruptedPage.promise; }
    else if (phase === 'limit') return response(current, { rateLimited: true, retryAfterSeconds: 120 });
    return response(current, { artworks: [row('2')], complete: true });
  } });
  f.collector.start(); await entered.promise;
  const cycleId = f.store.getMeta('collector:v1').accounts[analyticsAccountKey(a)].cycle.id;
  const closing = f.collector.close(); interruptedPage.resolve(); await closing;
  assert.deepEqual(f.completions, []);
  assert.equal(f.store.status().sampleCount, 1, 'the in-flight page is discarded after shutdown');
  phase = 'limit'; await f.restart(); f.setTime(1 + 2 / 60); await f.start();
  assert.deepEqual(f.completions, []);
  assert.equal(f.collector.status().accounts[0].remainingWorks, 1);
  const callsBeforeCooldown = f.calls.length;
  await f.restart(); f.setTime(1 + 3 / 60); await f.start({ force: true });
  assert.equal(f.calls.length, callsBeforeCooldown);
  assert.deepEqual(f.completions, [], 'manual retry during cooldown cannot mark completion');
  phase = 'finish'; f.setTime(1 + 5 / 60); await f.start();
  assert.deepEqual(f.completions, [{ accountId: analyticsAccountKey(a), input: {
    runId: cycleId, completedAt: at(1 + 5 / 60), expectedWorkCount: 2,
  }, recordedSamples: 2 }]);
  assert.equal(f.calls.filter(call => call.input.includeIndex).length, 1, 'restarts resume the original cycle');
});

test('a cycle with permanently failed artwork never commits a completed periodic summary', async t => {
  const f = fixture(t, { initialHours: 1, trackCompletions: true, handler: (current, input, { response }) => response(current,
    input.includeIndex ? { index: { complete: true, artworkIds: ['1', '2'] }, account: { views: 1000, followers: 50 } }
      : { artworks: input.artworkIds.includes('1') ? [row('1')] : [], attemptedArtworkIds: input.artworkIds }) });
  await f.start();
  assert.deepEqual(f.completions, []);
  assert.equal(f.store.status().sampleCount, 1);
  f.setTime(1 + 2 / 60); await f.start();
  assert.deepEqual(f.completions, []);
  assert.equal(f.collector.status().accounts[0].remainingWorks, null, 'the failed cycle can finish without being a valid daily baseline');
  assert.ok(f.collector.status().errors.some(error => /1 件作品/.test(error.message)));
  assert.equal(f.calls.filter(call => call.input.artworkIds).length, 2, 'the missing work is retried once before completion is refused');
});

test('manual account selection scopes the archive scan; scheduled idle does not recollect and force refresh stays scoped', async t => {
  const f = fixture(t, { accounts: [a, b] });
  await f.start({ accountId: 'a', force: true });
  assert.deepEqual(f.calls.map(call => call.accountId), ['a']);
  assert.equal(f.store.status({ accountId: analyticsAccountKey(a) }).accountSampleCount, 1);
  assert.equal(f.store.status({ accountId: analyticsAccountKey(b) }).accountSampleCount, 0);
  assert.equal(f.collector.status().accounts.find(item => item.accountId === 'a').nextRegularAt, at(6));
  await f.start({ accountId: 'a' }); assert.equal(f.calls.length, 1);
  f.setTime(1); await f.start({ accountId: 'a', force: true });
  assert.deepEqual(f.calls.map(call => call.accountId), ['a', 'a']);
  assert.equal(f.store.status().accountSampleCount, 2);
});

test('an empty index still records account statistics and schedules the next update six hours later', async t => {
  const f = fixture(t);
  const result = await f.start();
  assert.equal(result.recordedWorks, 0); assert.equal(result.recordedAccounts, 1); assert.equal(result.running, false);
  assert.equal(result.accounts[0].remainingWorks, null); assert.equal(result.accounts[0].nextRegularAt, at(6));
  f.setTime(5.99); await f.start(); assert.equal(f.calls.length, 1);
  f.setTime(6); await f.start(); assert.equal(f.calls.length, 2);
});

test('manual retry resumes a Chrome-consent failure immediately while automatic retries retain backoff', async t => {
  let allowed = false;
  const f = fixture(t, { handler: (current, input, { response }) => {
    if (!allowed) throw Object.assign(new Error('Chrome 尚未允许后台连接，请在远程调试提示中点击允许后重试。'), { code: 'approval_required' });
    return response(current, { index: { complete: true, artworkIds: [] }, account: { views: 20, followers: 2 } });
  } });
  await f.start(); assert.equal(f.calls.length, 1);
  const originalCycle = f.store.getMeta('collector:v1').accounts[analyticsAccountKey(a)].cycle.id;
  allowed = true;
  await f.restart(); await f.start(); assert.equal(f.calls.length, 1);
  await f.start({ force: true }); assert.equal(f.calls.length, 2);
  assert.equal(f.store.status().accountSampleCount, 1);
  assert.equal(f.store.getMeta('collector:v1').accounts[analyticsAccountKey(a)].retryAt, null);
  assert.ok(originalCycle.startsWith('periodic:'));
});

test('manual retry never bypasses a persisted Pixiv rate limit', async t => {
  const f = fixture(t, { handler: (current, input, { response }) => response(current, { rateLimited: true, retryAfterSeconds: 600 }) });
  await f.start(); assert.equal(f.calls.length, 1);
  await f.restart(); await f.start({ force: true });
  assert.equal(f.calls.length, 1);
  assert.equal(f.store.getMeta('collector:v1').accounts[analyticsAccountKey(a)].retryCode, 'rate_limited');
});

test('legacy consent backoff is recognized only from the exact saved consent error', async t => {
  const f = fixture(t);
  const key = analyticsAccountKey(a);
  for (const message of ['Unknown network error', 'Chrome 尚未允许后台连接，请在远程调试提示中点击允许后重试。']) {
    f.store.setMeta('collector:v1', { accounts: { [key]: { nextRegularAt: at(0), retryAt: at(1), failures: 5, cycle: null, milestoneRetries: {} } },
      run: { running: false, errors: [{ accountId: a.id, message }] } });
    await f.restart(); const before = f.calls.length;
    await f.start({ force: true });
    assert.equal(f.calls.length - before, message === 'Unknown network error' ? 0 : 1);
  }
});

test('a non-progressing detail response backs off instead of repeatedly polling in the same run', async t => {
  let unavailable = true;
  const f = fixture(t, { handler: (current, input, { response }) => response(current,
    input.includeIndex ? { index: { complete: true, artworkIds: ['1'] } }
      : unavailable ? { attemptedArtworkIds: [], artworks: [] } : { artworks: [row('1')], attemptedArtworkIds: ['1'] }) });
  await f.start(); assert.equal(f.calls.length, 2);
  assert.equal(f.collector.status().accounts[0].remainingWorks, 1);
  assert.equal(f.collector.status().accounts[0].retryAt, at(1 / 60));
  await f.start({ force: true }); assert.equal(f.calls.length, 2);
  unavailable = false; f.setTime(2 / 60); await f.start();
  assert.equal(f.store.status().sampleCount, 1); assert.equal(f.calls.length, 3);
});

test('rate-limited partial batches persist their remaining IDs and delay across restart without duplicating samples', async t => {
  let limited = true;
  const f = fixture(t, { handler: (current, input, { response }) => {
    if (input.includeIndex) return response(current, { index: { complete: true, artworkIds: ['1', '2', '3'] }, account: { views: 400, followers: 10 } });
    if (limited) { limited = false; return response(current, { artworks: [row('3')], attemptedArtworkIds: ['3', '2'], rateLimited: true, retryAfterSeconds: 90 }); }
    return response(current, { artworks: input.artworkIds.map(id => row(id)), attemptedArtworkIds: input.artworkIds });
  } });
  await f.start();
  assert.equal(f.store.status().sampleCount, 1); assert.equal(f.collector.status().accounts[0].remainingWorks, 2);
  await f.restart(); f.setTime(1 / 60); await f.start({ force: true }); assert.equal(f.calls.length, 2);
  f.setTime(91 / 3600); await f.start();
  assert.deepEqual(f.calls[2].input.artworkIds, ['2', '1']);
  assert.equal(f.store.status().sampleCount, 3); assert.equal(f.store.status().accountSampleCount, 1);
  assert.equal(f.collector.status().accounts[0].nextRegularAt, at(6));
});

test('a rate-limited account reading after an empty index remains pending and resumes as an account-only read', async t => {
  const f = fixture(t, { handler: (current, input, { response }) => response(current, input.includeIndex
    ? { index: { complete: true, artworkIds: [] }, account: { views: null, followers: null }, rateLimited: true, retryAfterSeconds: 120 }
    : { account: { views: 0, followers: 7 } }) });
  await f.start(); assert.equal(f.calls.length, 1); assert.equal(f.store.status().accountSampleCount, 0);
  assert.equal(f.collector.status().accounts[0].retryAt, at(2 / 60));
  await f.restart(); f.setTime(2 / 60); await f.start();
  assert.deepEqual(f.calls[1].input, { includeAccount: true });
  assert.equal(f.store.status().accountSampleCount, 1);
  assert.equal(f.store.report().accounts[0].latest.followers, 7);
});

test('invalid or foreign-owner detail rows are retried once and never counted as successful measurements', async t => {
  const f = fixture(t, { handler: (current, input, { response }) => response(current, input.includeIndex
    ? { index: { complete: true, artworkIds: ['1', '2'] } }
    : { artworks: [row('1', '999'), row('2', current.pixivUserId, { viewCount: null, bookmarkCount: null, likeCount: null })], attemptedArtworkIds: ['1', '2'] }) });
  await f.start(); assert.equal(f.store.status().sampleCount, 0); assert.equal(f.calls.length, 2);
  f.setTime(2 / 60); await f.start();
  assert.equal(f.calls.length, 3); assert.equal(f.store.status().sampleCount, 0);
  assert.equal(f.collector.status().accounts[0].remainingWorks, null);
  assert.match(f.collector.status().errors[0].message, /2 件作品/);
});

test('a context version change rejects an in-flight response even when the mode switches back to live', async t => {
  const wait = deferred();
  const f = fixture(t, { handler: async (current, _input, { response }) => { await wait.promise; return response(current,
    { index: { complete: true, artworkIds: ['1'] }, artworks: [row('1')], account: { views: 10, followers: 3 } }); } });
  f.collector.start(); await new Promise(resolve => setImmediate(resolve));
  f.context.mode = 'demo'; f.context.contextVersion++; f.context.mode = 'live'; f.context.contextVersion++;
  wait.resolve(); await f.collector.idle();
  assert.equal(f.store.status().sampleCount, 0); assert.equal(f.store.status().accountSampleCount, 0);
  assert.equal(f.calls.length, 1); assert.match(f.collector.status().errors[0].message, /已变更/);
});

test('rebinding an account during a run does not ingest the old response or start the new identity automatically', async t => {
  const wait = deferred();
  const f = fixture(t, { handler: async (current, _input, { response }) => { await wait.promise; return response(current,
    { index: { complete: true, artworkIds: [] }, account: { views: 10, followers: 3 } }); } });
  f.collector.start({ accountId: 'a' }); await new Promise(resolve => setImmediate(resolve));
  f.context.accounts[0].pixivUserId = '202'; f.context.contextVersion++;
  wait.resolve(); await f.collector.idle();
  assert.equal(f.calls.length, 1); assert.equal(f.store.status().accountSampleCount, 0);
  await f.start({ accountId: 'a' });
  assert.equal(f.calls[1].pixivUserId, '202');
  assert.equal(f.store.report().accounts[0].accountId, 'live:a:202');
});

test('precise-age readings run first and bounded periodic batches alternate between accounts', async t => {
  const ids = Array.from({ length: 25 }, (_, index) => String(index + 1));
  const f = fixture(t, { accounts: [a, b], initialHours: 6, seeds: current => [row('1', current.pixivUserId)],
    handler: (current, input, { response }) => response(current, input.includeIndex
      ? { index: { complete: true, artworkIds: ids } }
      : { artworks: input.artworkIds.map(id => row(id, current.pixivUserId)), attemptedArtworkIds: input.artworkIds }) });
  f.store.upsertWorks(analyticsAccountKey(a), [row('1')], { observedAt: BASE });
  f.store.upsertWorks(analyticsAccountKey(b), [row('1', '102')], { observedAt: BASE });
  await f.start();
  assert.deepEqual(f.calls.slice(0, 4).map(call => [call.accountId, call.input.includeIndex || false]), [['a', false], ['b', false], ['a', true], ['b', true]]);
  assert.deepEqual(f.calls.slice(4).map(call => call.accountId), ['a', 'b', 'a', 'b', 'a', 'b']);
  assert.ok(f.calls.every(call => !call.input.artworkIds || call.input.artworkIds.length <= 10));
  assert.equal(f.store.status().workCount, 50);
  assert.equal(f.store.report({ point: '6h' }).summary.sampledWorkCount, 50);
});

test('a cycle lasting beyond six hours skips missed cadence slots instead of starting a catch-up loop', async t => {
  const f = fixture(t, { handler: (current, _input, { response, setTime }) => {
    setTime(7); return response(current, { index: { complete: true, artworkIds: [] } });
  } });
  await f.start();
  assert.equal(f.calls.length, 1); assert.equal(f.collector.status().accounts[0].nextRegularAt, at(12));
  await f.start(); assert.equal(f.calls.length, 1);
});

test('verified seed metadata gives multi-character works their roles before milestone collection', async t => {
  const tags = ['崩壊スターレイル', '花火(スターレイル)', 'ロビン(スターレイル)'];
  const f = fixture(t, { initialHours: 6, seeds: [row('1', '101', { title: 'Untitled', tags })],
    handler: (current, input, { response }) => response(current, input.includeIndex
      ? { index: { complete: true, artworkIds: ['1'] } }
      : { artworks: [row('1', current.pixivUserId, { title: 'Untitled', tags })], attemptedArtworkIds: ['1'] }) });
  await f.start();
  assert.deepEqual(f.store.report({ group: 'character', point: '6h' }).rows.map(item => item.name).sort(), ['Robin', 'Sparkle']);
  assert.ok(f.store.report({ group: 'character', point: '6h' }).rows.every(item => item.sampleCount === 1));
});

test('a mismatched index scope rejects the entire response before recording account or artwork metrics', async t => {
  const f = fixture(t, { handler: (current, _input, { response }) => response(current,
    { index: { pixivUserId: '999', complete: true, artworkIds: ['1'] }, artworks: [row('1')], account: { views: 100, followers: 10 } }) });
  await f.start();
  assert.equal(f.calls.length, 1); assert.equal(f.store.status().sampleCount, 0); assert.equal(f.store.status().accountSampleCount, 0);
  assert.match(f.collector.status().errors[0].message, /索引与绑定/);
});

test('a manually scoped archive scan still services other accounts precise-age deadlines without scanning their archives', async t => {
  const ids = Array.from({ length: 21 }, (_, index) => String(index + 1));
  const f = fixture(t, { accounts: [a, b], initialHours: 6,
    handler: (current, input, { response }) => response(current, input.includeIndex
      ? { index: { complete: true, artworkIds: ids } }
      : { artworks: input.artworkIds.map(id => row(id, current.pixivUserId)), attemptedArtworkIds: input.artworkIds }) });
  f.store.upsertWorks(analyticsAccountKey(b), [row('99', '102')], { observedAt: BASE });
  await f.start({ accountId: 'a', force: true });
  assert.deepEqual(f.calls[0], { accountId: 'b', pixivUserId: '102', input: { artworkIds: ['99'] } });
  assert.equal(f.calls.filter(call => call.accountId === 'b').length, 1);
  assert.equal(f.calls.filter(call => call.input.includeIndex).length, 1);
  assert.equal(f.calls.find(call => call.input.includeIndex).accountId, 'a');
  assert.equal(f.store.report({ accountId: analyticsAccountKey(b), point: '6h' }).rows[0].total, 100);
});
