import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server/index.mjs';
import { createDemoState, blankState } from '../server/seed.mjs';
import { analyticsAccountKey } from '../server/analytics-collector.mjs';

const NOW = '2026-10-15T06:00:00.000Z';
const account = (id, user) => ({ id, name: `Account ${id}`, pixivUserId: user, connected: true, premium: true, paused: true,
  timezone: 'Asia/Tokyo', browser: { targetId: id.repeat(32), postingEnabled: false }, remote: { reservations: [], total: 0 } });
const accounts = [account('a', '101'), account('b', '202')];
const artwork = (account, id) => ({ artworkId: id, userId: account.pixivUserId, title: 'Example', tags: ['オリジナル'],
  createDate: '2026-10-15T00:00:00.000Z', observedAt: NOW, viewCount: 100, bookmarkCount: 10, likeCount: 5 });
async function fixture(t, analytics, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'atelier-analytics-api-'));
  const live = blankState(); live.accounts = structuredClone(accounts); live.settings.queuePaused = true;
  await fs.writeFile(path.join(dataDir, 'state.json'), JSON.stringify({ version: 1, mode: 'live', states: { live, demo: createDemoState(NOW) }, uploads: {} }));
  let posts = 0; const calls = [];
  const server = await createServer({ dataDir, background: false, analyticsBatchDelayMs: 0, now: () => new Date(NOW),
    thumbnailFetch: options.thumbnailFetch,
    tagger: { status: async () => ({ ready: false }), close() {} }, browserConnector: {
      async analytics(a, input) { calls.push({ accountId: a.id, input }); return analytics ? analytics(a, input) : {
        pixivUserId: a.pixivUserId, observedAt: NOW, complete: true, errors: [],
        index: input.includeIndex ? { complete: true, artworkIds: [a.pixivUserId + '01'] } : null,
        account: input.includeAccount ? { viewCount: 10000, followerCount: 100, observedAt: NOW, source: 'test' } : null,
        artworks: (input.artworkIds || []).map(id => artwork(a, id)), attemptedArtworkIds: input.artworkIds || [],
      }; },
      async snapshot() { throw new Error('analytics must not run reservation sync'); },
      async reserve() { posts++; throw new Error('analytics must never post'); }, close() {},
    } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (url, body) => { const response = await fetch(base + url, { method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: response.status, data: await response.json() }; };
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await server.analyticsClosed;
    assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir())); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { server, request, base, calls, posts: () => posts };
}

test('analytics collection works for paused/read-only accounts, isolates account selection, and never submits', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/analytics/collect', { accountId: 'a' })).status, 202);
  await f.server.analytics.collector.idle();
  assert.ok(f.calls.every(call => call.accountId === 'a'));
  assert.equal(f.posts(), 0);
  const report = (await f.request('/api/analytics?accountId=a&point=6h&metric=views')).data;
  assert.equal(report.rows.length, 1); assert.equal(report.rows[0].total, 100);
  assert.equal(report.rows[0].accountId, 'a'); assert.equal(report.rows[0].latenessMs, 0);
  assert.equal(report.accounts[0].latest.followers, 100); assert.equal(report.accounts[0].latest.views, 10000);
  assert.equal((await f.request('/api/analytics?accountId=b')).data.rows.length, 0);
});

test('long read is asynchronous; mode round-trip rejects delayed data and demo exposes no live reports', async t => {
  let release, entered; const entry = new Promise(resolve => entered = resolve), gate = new Promise(resolve => release = resolve);
  const f = await fixture(t, async (a, input) => { entered(); await gate; return { pixivUserId: a.pixivUserId, observedAt: NOW,
    index: { complete: true, artworkIds: [] }, artworks: [artwork(a, '901')], errors: [] }; });
  const started = await f.request('/api/analytics/collect', { accountId: 'a' }); assert.equal(started.status, 202); await entry;
  assert.equal((await f.request('/api/state')).status, 200);
  await f.request('/api/mode', { mode: 'demo' }); await f.request('/api/mode', { mode: 'live' }); release();
  await f.server.analytics.collector.idle();
  assert.equal((await f.request('/api/analytics')).data.rows.length, 0);
  f.server.analytics.store.recordBatch(analyticsAccountKey(accounts[0]), { works: [{ artworkId: '900', publishedAt: NOW, metrics: { views: 777 } }], observedAt: NOW });
  await f.request('/api/mode', { mode: 'demo' });
  assert.equal((await f.request('/api/analytics')).data.rows.length, 0);
  assert.equal((await f.request('/api/analytics/status')).data.workCount, 0);
  assert.equal((await f.request('/api/analytics/collect', {})).status, 409);
});

test('reports exclude removed/rebound identities and validate filter inputs', async t => {
  const f = await fixture(t);
  for (const key of [analyticsAccountKey(accounts[0]), 'live:removed:404', 'live:a:old']) f.server.analytics.store.recordBatch(key,
    { works: [{ artworkId: '900', publishedAt: NOW, metrics: { views: 777 } }], observedAt: NOW });
  assert.equal((await f.request('/api/analytics')).data.rows.length, 1);
  assert.equal((await f.request('/api/analytics/status')).data.workCount, 1);
  for (const query of ['metric=followers', 'point=3h', 'sort=random', 'limit=1000', 'offset=-1', 'days=31', 'days=-30', 'days=0', 'dailyDays=0', 'dailyDays=31', 'dailyDays=all']) assert.equal((await f.request('/api/analytics?' + query)).status, 400);
  assert.equal((await f.request('/api/analytics?accountId=missing')).status, 404);
  const before = f.server.analytics.store.status().milestones;
  assert.equal((await f.request('/api/analytics?now=2100-01-01')).status, 400);
  assert.deepEqual(f.server.analytics.store.status().milestones, before, 'HTTP clients cannot advance milestone time');
});

test('all metric columns and bookmark ratios remain scoped and sort before pagination', async t => {
  const f = await fixture(t), key = analyticsAccountKey(accounts[0]);
  f.server.analytics.store.recordBatch(key, { observedAt: NOW, works: [
    { artworkId: '901', title: 'More views', publishedAt: NOW, tags: ['Group'], metrics: { views: 100, bookmarks: 10, likes: 5 } },
    { artworkId: '902', title: 'Higher ratio', publishedAt: NOW, tags: ['Group'], metrics: { views: 20, bookmarks: 10, likes: 2 } },
    { artworkId: '903', title: 'No views', publishedAt: NOW, tags: ['Group'], metrics: { views: 0, bookmarks: 3, likes: 0 } },
    { artworkId: '904', title: 'Older', publishedAt: '2025-01-01T00:00:00.000Z', tags: ['Group'], metrics: { views: 100, bookmarks: 100, likes: 5 } },
  ] });
  f.server.analytics.store.recordBatch(analyticsAccountKey(accounts[1]), { observedAt: NOW, works: [
    { artworkId: '905', title: 'Other account', publishedAt: NOW, tags: ['Group'], metrics: { views: 100, bookmarks: 100, likes: 99 } },
  ] });
  const first = await f.request('/api/analytics?accountId=a&days=30&metric=bookmarkRate&sort=growth&limit=1');
  assert.equal(first.status, 200);
  assert.equal(first.data.filters.sort, 'total', 'ratios do not become per-hour growth');
  assert.equal(first.data.rows[0].artworkId, '902');
  assert.deepEqual(first.data.rows[0].metrics, { views: 20, bookmarks: 10, likes: 2, bookmarkRate: 0.5 });
  assert.equal(first.data.pagination.total, 3);
  const second = (await f.request('/api/analytics?accountId=a&days=30&metric=bookmarkRate&limit=1&offset=1')).data;
  assert.equal(second.rows[0].artworkId, '901');
  const missing = (await f.request('/api/analytics?accountId=a&days=30&metric=bookmarkRate&limit=1&offset=2')).data;
  assert.equal(missing.rows[0].metrics.bookmarkRate, null);
  const grouped = (await f.request('/api/analytics?accountId=a&days=30&group=tag&metric=bookmarkRate&sort=average')).data;
  assert.equal(grouped.rows[0].metrics.bookmarkRate, 20 / 120);
  assert.equal(grouped.rows[0].metrics.bookmarks, 23, 'counts retain zero-view works even when ratio excludes them');
  assert.equal(grouped.rows[0].averageMetrics.views, 40);
  assert.equal(grouped.rows[0].metricSampleCounts.bookmarkRate, 2);
  assert.equal(f.calls.length, 0, 'ratio reports use saved data without browser collection');
  assert.equal(f.posts(), 0);
});

const thumbnail = id => `https://i.pximg.net/c/250x250_80_a2/img-master/img/2026/10/15/00/00/00/${id}_p0_square1200.jpg`;
const smallPng = Buffer.from([137,80,78,71,13,10,26,10,0]);

test('ranking exposes only account-scoped local thumbnails and the proxy caches verified sources', async t => {
  const fetched = [];
  const f = await fixture(t, undefined, { thumbnailFetch: async (url, options) => {
    fetched.push(url); assert.equal(options.credentials, 'omit');
    return new Response(smallPng, { headers: { 'content-type': 'image/png' } });
  } });
  f.server.analytics.store.recordBatch(analyticsAccountKey(accounts[0]), { works: [{ artworkId: '901', title: 'Thumbnail example',
    publishedAt: NOW, thumbnailUrl: thumbnail('901'), metrics: { views: 30 } }], observedAt: NOW });
  const report = (await f.request('/api/analytics?accountId=a')).data;
  const localUrl = report.rows[0].thumbnailUrl;
  assert.match(localUrl, /^\/api\/analytics\/accounts\/a\/works\/901\/thumbnail\?v=[a-f0-9]{12}$/);
  assert.doesNotMatch(JSON.stringify(report), /i\.pximg\.net/);
  for (let n=0;n<2;n++) {
    const image = await fetch(f.base + localUrl);
    assert.equal(image.status, 200); assert.equal(image.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), smallPng);
  }
  assert.deepEqual(fetched, [thumbnail('901')]);
  assert.equal((await fetch(f.base + '/api/analytics/accounts/b/works/901/thumbnail?url=https://example.test/')).status, 404);
  assert.equal((await fetch(f.base + '/api/analytics/accounts/a/works/902/thumbnail')).status, 404);
  await f.request('/api/mode', { mode: 'demo' });
  assert.equal((await fetch(f.base + localUrl)).status, 404);
  assert.equal(fetched.length, 1);
});

test('thumbnail requests recheck workspace identity after an in-flight download', async t => {
  let release, entered;
  const entry = new Promise(resolve => entered=resolve), gate = new Promise(resolve => release=resolve);
  const f=await fixture(t, undefined, { thumbnailFetch: async () => { entered(); await gate; return new Response(smallPng, {headers:{'content-type':'image/png'}}); } });
  f.server.analytics.store.upsertWorks(analyticsAccountKey(accounts[0]), [{artworkId:'901',publishedAt:NOW,thumbnailUrl:thumbnail('901')}]);
  const response=fetch(f.base+'/api/analytics/accounts/a/works/901/thumbnail'); await entry;
  await f.request('/api/mode',{mode:'demo'}); await f.request('/api/mode',{mode:'live'}); release();
  assert.equal((await response).status,404);
});

test('publication filters run before group averages and interval reports expose adjacent-node growth', async t => {
  const f=await fixture(t), key=analyticsAccountKey(accounts[0]);
  const hoursAgo=n=>new Date(Date.parse(NOW)-n*3600000).toISOString();
  f.server.analytics.store.recordBatch(key,{account:{views:0,followers:0},observedAt:hoursAgo(24),runId:'enable'});
  f.server.analytics.store.recordBatch(key,{works:[{artworkId:'901',title:'New',tags:['Group'],publishedAt:hoursAgo(12),publicationTimeVerified:true,metrics:{views:100,bookmarks:10,likes:4}}],observedAt:hoursAgo(6),runId:'six'});
  f.server.analytics.store.recordBatch(key,{works:[{artworkId:'901',metrics:{views:250,bookmarks:40,likes:10}},{artworkId:'902',title:'Old',tags:['Group'],publishedAt:hoursAgo(60*24),metrics:{views:1000}}],observedAt:NOW,runId:'twelve'});
  const recent=(await f.request('/api/analytics?group=tag&days=30')).data;
  assert.equal(recent.rows[0].average,250);assert.equal(recent.rows[0].workCount,1);
  assert.equal((await f.request('/api/analytics?group=tag&days=90')).data.rows[0].average,625);
  for(const days of ['all','30','90','180','365'])assert.equal((await f.request('/api/analytics?days='+days)).status,200);
  const interval=(await f.request('/api/analytics?group=interval&point=12h&days=30')).data;
  assert.equal(interval.filters.sort,'growth');assert.equal(interval.rows[0].delta,150);assert.equal(interval.rows[0].growth,25);
  assert.equal(interval.rows[0].accountId,'a');assert.equal(interval.rows[0].interval.fromPoint,'6h');
  assert.equal(interval.rows[0].deltaMetrics.bookmarks,30);assert.equal(interval.rows[0].deltaMetrics.likes,6);
  assert.equal(interval.rows[0].growthMetrics.bookmarks,5);assert.equal(interval.rows[0].metrics.bookmarkRate,40/250);
  const ratio=(await f.request('/api/analytics?group=interval&point=12h&days=30&metric=bookmarkRate')).data;
  assert.equal(ratio.filters.sort,'total');assert.equal(ratio.rows[0].total,40/250);
  assert.equal(ratio.rows[0].growth,null,'endpoint ratio is not an interval growth rate');
});

test('account overview totals remain account scoped and independent of ranking filters through the API', async t => {
  const f = await fixture(t), key = analyticsAccountKey(accounts[0]);
  f.server.analytics.store.recordBatch(key, {
    works: [
      { artworkId: '901', title: 'Recent', publishedAt: NOW, metrics: { views: 120, bookmarks: 12, likes: 4 } },
      { artworkId: '902', title: 'Older', publishedAt: '2025-01-01T00:00:00.000Z', metrics: { views: 300, bookmarks: 30, likes: 20 } },
    ], account: { views: 999, followers: 42 }, observedAt: NOW, runId: 'overview',
  });
  for (const otherKey of [analyticsAccountKey(accounts[1]), 'live:a:old', 'live:removed:404']) {
    f.server.analytics.store.recordBatch(otherKey, { works: [{ artworkId: '903', publishedAt: NOW,
      metrics: { views: 1000, bookmarks: 1000, likes: 1000 } }], observedAt: NOW });
  }
  const filtered = (await f.request('/api/analytics?accountId=a&days=30&point=7d&group=tag&query=absent&limit=1&offset=10')).data;
  assert.equal(filtered.rows.length, 0);
  assert.equal(filtered.accounts.length, 1);
  assert.equal(filtered.accounts[0].accountId, 'a');
  assert.equal(filtered.accounts[0].latest.views, 999, 'official account views stay distinct from work totals');
  assert.deepEqual(filtered.accounts[0].totals, {
    views: 420, bookmarks: 42, likes: 24, workCount: 2,
    metricCounts: { views: 2, bookmarks: 2, likes: 2 }, observedAt: NOW,
  });
  const all = (await f.request('/api/analytics')).data;
  assert.deepEqual(all.accounts.map(item => [item.accountId, item.totals.bookmarks]), [['a', 42], ['b', 1000]]);
  assert.ok(!JSON.stringify(all.accounts).includes('live:removed:404'));
});

test('daily account changes pass through the API with their own date range and preserve negative follower changes', async t => {
  const f = await fixture(t), key = analyticsAccountKey(accounts[0]);
  const earlier = '2026-10-14T12:00:00.000Z';
  const sources = { viewCount: { surface: 'report-top-summary', section: 'access' },
    followerCount: { seriesId: 'pixiv-followers-page-total-v1' } };
  for (const [at, runId, views, bookmarks, likes, followers] of [
    [earlier, 'daily-before', 900, 10, 5, 10], [NOW, 'daily-now', 1000, 15, 8, 9],
  ]) {
    f.server.analytics.store.recordBatch(key, { observedAt: at, runId, kind: 'periodic',
      account: { views, followers, sources },
      works: [{ artworkId: '901', title: 'Daily example', publishedAt: '2026-10-01T00:00:00.000Z',
        metrics: { views, bookmarks, likes } }],
    });
    f.server.analytics.store.completePeriodicRun(key, { runId, completedAt: at, expectedWorkCount: 1 });
  }
  const result = await f.request('/api/analytics?accountId=a&dailyDays=7&days=30&group=tag&query=absent');
  assert.equal(result.status, 200); assert.equal(result.data.rows.length, 0);
  const daily = result.data.accounts[0].daily;
  assert.equal(daily.timezone, 'Asia/Shanghai'); assert.equal(daily.days, '7');
  assert.equal(daily.today.date, '2026-10-15');
  assert.deepEqual(Object.fromEntries(Object.entries(daily.today.metrics).map(([metric, value]) => [metric, value.delta])),
    { views: 100, bookmarks: 5, likes: 3, followers: -1 });
  assert.ok(Object.values(daily.today.metrics).every(item => item.status === 'complete'));
  for (const dailyDays of ['30', '90', '365']) {
    const ranged = (await f.request('/api/analytics?accountId=a&dailyDays=' + dailyDays)).data;
    assert.deepEqual(ranged.accounts[0].daily.today, daily.today);
  }
  assert.equal((await f.request('/api/analytics?accountId=b&dailyDays=7')).data.accounts[0].daily?.today?.metrics?.followers?.delta ?? null, null);
});
