import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAnalyticsStore, inferAnalyticsCharacters } from '../server/analytics.mjs';

const START = '2026-10-01T00:00:00.000Z';
const at = hours => new Date(Date.parse(START) + hours * 3600000).toISOString();
const work = (id = '1', changes = {}) => ({ artworkId: id, title: `Artwork ${id}`, publishedAt: START, tags: ['tag'],
  characters: [{ key: 'hero:game', name: 'Hero' }], ...changes });
const observed = (id, views, bookmarks = null, likes = null, changes = {}) => work(id, { metrics: { views, bookmarks, likes }, ...changes });
function fixture(t, initialHours = 0) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'pixiv-analytics-'));
  let hours = initialHours, store = createAnalyticsStore({ dataDir, now: () => new Date(at(hours)) });
  t.after(() => { store.close(); rmSync(dataDir, { recursive: true, force: true }); });
  return { get store() { return store; }, setTime(value) { hours = value; }, restart() { store.close(); store = createAnalyticsStore({ dataDir, now: () => new Date(at(hours)) }); } };
}

test('samples and resumable metadata persist, with isolated same-artwork account histories and idempotent batches', t => {
  const f = fixture(t, 6);
  f.store.recordBatch('a', { works: [observed('1', 100, 4, 7)], account: { views: 3000, followers: 20 }, observedAt: at(6), runId: 'cycle' });
  f.store.recordBatch('a', { works: [observed('1', 999)], account: { views: 9999, followers: 999 }, observedAt: at(6.1), runId: 'cycle' });
  f.store.recordBatch('b', { works: [observed('1', 800)], account: { views: 2000, followers: 10 }, observedAt: at(6), runId: 'cycle' });
  f.store.setMeta('progress:a', { remaining: ['2'], nextAt: at(12) });
  f.restart();
  assert.equal(f.store.report({ accountId: 'a' }).rows[0].total, 100);
  assert.equal(f.store.report({ accountId: 'b' }).rows[0].total, 800);
  assert.equal(f.store.report({ accountId: 'a' }).accounts[0].latest.followers, 20);
  assert.deepEqual(f.store.getMeta('progress:a'), { remaining: ['2'], nextAt: at(12) });
  assert.equal(f.store.status().sampleCount, 2);
  assert.equal(f.store.status().accountSampleCount, 2);
});

test('old works never borrow current numbers for missed age checkpoints', t => {
  const f = fixture(t, 200);
  f.store.recordBatch('a', { works: [observed('1', 900)], observedAt: at(200), runId: 'initial' });
  for (const point of ['6h', '12h', '24h', '7d']) {
    const row = f.store.report({ point }).rows[0];
    assert.equal(row.status, 'missing'); assert.equal(row.total, null); assert.equal(row.observedAt, null);
    assert.equal(row.missingReason, 'missed_window');
  }
  assert.equal(f.store.report().rows[0].total, 900);
  assert.deepEqual(f.store.status().milestones, { pending: 0, recorded: 0, missing: 4 });
  assert.deepEqual(f.store.dueMilestones(), []);
});

test('independent age deadlines retain actual time and lateness, and each node keeps its first eligible observation', t => {
  const f = fixture(t);
  f.store.upsertWorks('a', [work()]);
  f.setTime(5.99); assert.equal(f.store.dueMilestones().length, 0);
  f.setTime(6.1);
  assert.deepEqual(f.store.dueMilestones().map(row => [row.point, row.targetAt]), [['6h', at(6)]]);
  f.store.recordBatch('a', { works: [observed('1', 100)], observedAt: at(6.1), runId: 'six', kind: 'milestone' });
  f.setTime(6.2);
  f.store.recordBatch('a', { works: [observed('1', 200)], observedAt: at(6.2), runId: 'six-later' });
  const row = f.store.report({ point: '6h' }).rows[0];
  assert.equal(row.total, 100); assert.equal(row.observedAt, at(6.1)); assert.equal(row.targetAt, at(6));
  assert.equal(row.latenessMs, 360000); assert.equal(row.lateCount, 1);
  assert.equal(f.store.dueMilestones().length, 0);
  assert.equal(f.store.status().nextMilestoneAt, at(12));
  f.setTime(12.5001);
  f.store.recordBatch('a', { works: [observed('1', 300)], observedAt: at(12.5001), runId: 'too-late' });
  assert.equal(f.store.report({ point: '12h' }).rows[0].status, 'missing');
});

test('zero is an observation while failed details and absent metrics are not zero', t => {
  const f = fixture(t, 6);
  f.store.recordBatch('a', { works: [observed('1', 0, 0, 0), observed('2', null, null, null)], observedAt: at(6), runId: 'six' });
  assert.equal(f.store.status().sampleCount, 1);
  let result = f.store.report({ point: '6h' });
  assert.equal(result.rows.find(row => row.artworkId === '1').total, 0);
  assert.equal(result.rows.find(row => row.artworkId === '2').total, null);
  assert.equal(result.summary.sampledWorkCount, 1);
  f.setTime(7);
  f.store.recordBatch('a', { works: [observed('1', null), observed('2', 10, null, 2)], observedAt: at(7), runId: 'later' });
  result = f.store.report();
  assert.equal(result.rows.find(row => row.artworkId === '1').observedAt, at(6));
  assert.equal(result.rows.find(row => row.artworkId === '2').metrics.bookmarks, null);
  const bookmarks = f.store.report({ metric: 'bookmarks', group: 'tag' }).rows[0];
  assert.equal(bookmarks.average, 0); assert.equal(bookmarks.sampleCount, 1); assert.equal(bookmarks.missingCount, 1);
});

test('new-work milestone growth uses cumulative counts divided by actual age and averages works equally', t => {
  const f = fixture(t);
  f.store.recordBatch('a', { account: { views: 0, followers: 0 }, observedAt: at(0), runId: 'enable' });
  f.setTime(5.1);
  f.store.recordBatch('a', { works: [observed('old', 1200, 10, 5, { publishedAt: at(-1), tags: ['tag', 'historical-only'] })], observedAt: at(5.1), runId: 'old-six' });
  f.setTime(7.1);
  f.store.recordBatch('a', { works: [observed('1', 61, 0, 0, { publishedAt: at(1) }), observed('2', 122, null, null, { publishedAt: at(1) })], observedAt: at(7.1), runId: 'six' });
  const result = f.store.report({ point: '6h', sort: 'growth' }), rows = result.rows;
  assert.equal(rows.length, 2); assert.equal(result.summary.excludedHistoricalCount, 1);
  assert.equal(rows[0].artworkId, '2'); assert.equal(rows[0].growth, 20);
  assert.equal(rows[1].growth, 10); assert.equal(rows[1].baselineAt, at(1)); assert.equal(rows[1].intervalHours, 6.1);
  const hero = f.store.report({ point: '6h', group: 'character', sort: 'growth' }).rows[0];
  assert.equal(hero.workCount, 2); assert.equal(hero.sampleCount, 2); assert.equal(hero.growthSampleCount, 2);
  assert.equal(hero.total, 183); assert.equal(hero.average, 91.5); assert.equal(hero.growth, 15);
  assert.deepEqual(f.store.report({ point: '6h', group: 'tag', sort: 'growth' }).rows.map(item => item.name), ['tag']);
  const historical = f.store.report({ point: '6h' }).rows.find(item => item.artworkId === 'old');
  assert.equal(historical.total, 1200); assert.equal(historical.growth, null);
  assert.equal(historical.growthExcludedReason, 'published_before_enabled');
  const current = f.store.report().rows.find(row => row.artworkId === '1');
  assert.equal(current.growth, null); assert.equal(current.baselineAt, null); assert.equal(current.intervalHours, null);
  assert.equal(f.store.report({ sort: 'growth' }).rows.length, 0);
});

test('all sorting and search are applied before pagination; duplicate tags and identities do not double count', t => {
  const f = fixture(t, 6);
  f.store.recordBatch('a', { works: [observed('1', 5, null, null, { tags: ['A', 'A'], title: 'First' }),
    observed('2', 100, null, null, { tags: ['B'], title: 'Second' }), observed('3', 20, null, null, { tags: ['A'], title: 'Third' })], observedAt: at(6) });
  assert.deepEqual(f.store.report({ limit: 1, offset: 1 }).rows.map(row => row.title), ['Third']);
  const search = f.store.report({ query: 'Third', limit: 1 });
  assert.equal(search.pagination.total, 1); assert.equal(search.rows[0].total, 20);
  const tag = f.store.report({ group: 'tag', query: 'A' }).rows[0];
  assert.equal(tag.workCount, 2); assert.equal(tag.total, 25);
  assert.equal(f.store.report({ group: 'tag', sort: 'average' }).rows[0].name, 'B');
});

test('unknown publication time remains explicitly missing at age checkpoints and roles are not inferred from titles', t => {
  const f = fixture(t, 200);
  f.store.recordBatch('a', { works: [observed('1', 10, null, null, { publishedAt: null, characters: [] })] });
  assert.equal(f.store.report({ point: '6h' }).rows[0].missingReason, 'unknown_publication_time');
  assert.equal(f.store.report({ group: 'character' }).rows.length, 0);
  const roles = inferAnalyticsCharacters([{ artworkId: '1', title: 'Sparkle', tags: ['pretty'] },
    { artworkId: '2', title: 'Sparkle', tags: ['崩壊スターレイル', '花火(スターレイル)'] }]);
  assert.equal(roles.has('1'), false);
  assert.equal(roles.get('2')[0].name, 'Sparkle');
});

test('corrected publication times remap age nodes from real samples instead of preserving false labels', t => {
  const f = fixture(t, 6);
  f.store.recordBatch('a', { works: [observed('1', 100)], observedAt: at(6) });
  assert.equal(f.store.report({ point: '6h' }).rows[0].total, 100);
  f.store.upsertWorks('a', [work('1', { publishedAt: at(1) })]);
  assert.equal(f.store.report({ point: '6h' }).rows[0].status, 'pending');
  assert.equal(f.store.report({ point: '6h' }).rows[0].total, null);
  assert.equal(f.store.report().rows[0].total, 100);
  assert.equal(f.store.status().sampleCount, 1);
});

test('a partially finished large account cycle resumes without duplicates or dropping later pages', t => {
  const f = fixture(t, 200);
  const works = Array.from({ length: 1200 }, (_, index) => observed(String(index + 1), index, index % 11, index % 17));
  f.store.recordBatch('a', { works: works.slice(0, 400), observedAt: at(200), runId: 'large-cycle' });
  f.store.setMeta('cursor:a', { completed: 400 });
  f.restart();
  for (let index = 300; index < works.length; index += 150) {
    f.store.recordBatch('a', { works: works.slice(index, index + 150), observedAt: at(200), runId: 'large-cycle' });
  }
  assert.equal(f.store.status().workCount, 1200);
  assert.equal(f.store.status().sampleCount, 1200);
  const result = f.store.report({ group: 'tag' });
  assert.equal(result.rows[0].sampleCount, 1200);
  assert.equal(result.rows[0].total, 1200 * 1199 / 2);
  const last = f.store.report({ limit: 25, offset: 1199 });
  assert.equal(last.pagination.total, 1200);
  assert.equal(last.rows.length, 1); assert.equal(last.rows[0].total, 0);
});

test('allowed account sets exclude removed or rebound identities, including empty and denied explicit selections', t => {
  const f = fixture(t, 6);
  for (const id of ['live:local:old', 'live:local:new', 'demo:local:new']) {
    f.store.recordBatch(id, { works: [observed('1', 5)], account: { views: 5, followers: 1 }, observedAt: at(6), runId: 'six' });
  }
  const accountIds = ['live:local:new'];
  assert.equal(f.store.report({ accountIds }).rows.length, 1);
  assert.equal(f.store.report({ accountIds }).accounts[0].accountId, 'live:local:new');
  assert.equal(f.store.status({ accountIds }).sampleCount, 1);
  assert.equal(f.store.report({ accountIds, accountId: 'live:local:old' }).pagination.total, 0);
  assert.equal(f.store.report({ accountIds: [] }).summary.workCount, 0);
  assert.equal(f.store.report({ accountIds: [] }).accounts.length, 0);
  assert.equal(f.store.status({ accountIds: [] }).sampleCount, 0);
  f.setTime(12);
  assert.equal(f.store.dueMilestones({ accountIds }).length, 1);
  assert.equal(f.store.dueMilestones({ accountIds: [] }).length, 0);
});

test('multiple explicit game-scoped character tags are attributed without inventing roles from ambiguous names', () => {
  const works = [{ artworkId: '1', title: 'Untitled', tags: ['崩壊スターレイル', '花火(スターレイル)', 'ロビン(スターレイル)'] },
    { artworkId: '2', title: 'Sparkle & Robin', tags: ['pretty'] },
    { artworkId: '3', title: 'Untitled', tags: ['custom game', 'shared name'] }];
  const roles = inferAnalyticsCharacters(works, { characters: [
    { englishName: 'Alpha', gameTags: ['custom game'], characterTags: ['shared name'] },
    { englishName: 'Beta', gameTags: ['custom game'], characterTags: ['shared name'] },
  ] });
  assert.deepEqual(roles.get('1').map(row => row.name).sort(), ['Robin', 'Sparkle']);
  assert.equal(roles.has('2'), false); assert.equal(roles.has('3'), false);
});

test('each account freezes its first successful collection cutoff across restart and older late-arriving observations', t => {
  const f = fixture(t, 2);
  f.store.upsertWorks('a', [work('seed', { publishedAt: at(1) })]);
  f.store.recordBatch('a', { works: [observed('failed', null)], observedAt: at(2), runId: 'failed' });
  assert.equal(f.store.report({ accountId: 'a' }).accounts[0].enabledAt, null);
  f.setTime(4);
  f.store.recordBatch('a', { account: { views: 0, followers: 0 }, observedAt: at(4), runId: 'enable-a' });
  f.restart();
  f.setTime(6);
  f.store.recordBatch('a', { works: [observed('late-arrival', 50)], observedAt: at(1), runId: 'arrived-late' });
  f.store.recordBatch('b', { account: { views: 0, followers: 0 }, observedAt: at(6), runId: 'enable-b' });
  assert.equal(f.store.report({ accountId: 'a' }).accounts[0].enabledAt, at(4));
  assert.equal(f.store.report({ accountId: 'b' }).accounts[0].enabledAt, at(6));
  f.restart(); f.setTime(10.5);
  for (const accountId of ['a', 'b']) f.store.recordBatch(accountId, { works: [observed('same-age', 120, 3, 2, { publishedAt: at(4.5) })], observedAt: at(10.5), runId: 'six' });
  const all = f.store.report({ point: '6h' });
  assert.equal(all.rows.find(item => item.accountId === 'a' && item.artworkId === 'same-age').growth, 20);
  assert.equal(all.rows.find(item => item.accountId === 'b' && item.artworkId === 'same-age').growth, null);
  assert.equal(f.store.report({ point: '6h', sort: 'growth' }).rows.filter(item => item.artworkId === 'same-age').length, 1);
  assert.equal(f.store.report({ accountId: 'a' }).accounts[0].enabledAt, at(4));
});

test('all four age checkpoints use their own actual age and a first six-hour sample needs no invented baseline observation', t => {
  const f = fixture(t);
  f.store.recordBatch('a', { account: { views: 0 }, observedAt: at(0), runId: 'enable' });
  for (const [point, hours] of [['6h', 6], ['12h', 12], ['24h', 24], ['7d', 168]]) {
    f.setTime(1 + hours + .25);
    f.store.recordBatch('a', { works: [observed('1', (hours + .25) * 40, null, 0, { publishedAt: at(1) })],
      observedAt: at(1 + hours + .25), runId: point });
    const row = f.store.report({ point, sort: 'growth' }).rows[0];
    assert.equal(row.growth, 40); assert.equal(row.growthSampleCount, 1); assert.equal(row.intervalHours, hours + .25);
    assert.equal(row.growthMetrics.bookmarks, null); assert.equal(row.growthMetrics.likes, 0);
    assert.equal(row.baselineKind, 'publication_start'); assert.equal(row.enabledAt, at(0));
  }
  assert.equal(f.store.status().sampleCount, 4);
  assert.equal(f.store.report().rows[0].growth, null);
  assert.equal(f.store.report().methodology.growthAvailable, false);
});

test('a tentative bulk publication timestamp cannot overwrite a detail-verified date or move its milestones', t => {
  const f = fixture(t);
  f.store.recordBatch('a', { account: { views: 0 }, observedAt: at(0), runId: 'enable' });
  f.setTime(7);
  f.store.recordBatch('a', { works: [observed('1', 120, null, null, { publishedAt: at(1),
    publicationTimeVerified: true, createDateSource: 'pixiv-artwork-detail' })], observedAt: at(7), runId: 'detail' });
  f.restart(); f.setTime(7.1);
  f.store.recordBatch('a', { works: [observed('1', 130, null, null, { publishedAt: at(1 + 22 / 3600),
    publicationTimeVerified: false, createDateSource: 'pixiv-management-thumbnail' })], observedAt: at(7.1), runId: 'bulk' });
  const selected = f.store.report({ point: '6h' }).rows[0];
  assert.equal(selected.publishedAt, at(1)); assert.equal(selected.targetAt, at(7)); assert.equal(selected.total, 120);
  assert.equal(selected.publicationTimeVerified, true); assert.equal(selected.createDateSource, 'pixiv-artwork-detail');
  assert.equal(selected.growth, 20); assert.equal(f.store.report().rows[0].total, 130);
});

test('explicitly provisional bulk times are unavailable to milestone sampling and growth until detail calibration', t => {
  const f = fixture(t);
  f.store.recordBatch('a', { account: { views: 0 }, observedAt: at(0), runId: 'enable' });
  f.setTime(7.2);
  f.store.recordBatch('a', { works: [observed('1', 124, null, null, { publishedAt: at(1 + 22 / 3600),
    publicationTimeVerified: false, createDateSource: 'pixiv-management-thumbnail' })], observedAt: at(7.2), runId: 'bulk' });
  assert.equal(f.store.getEnabledAt('a'), at(0));
  assert.equal(f.store.report().rows[0].total, 124);
  assert.equal(f.store.report({ point: '6h' }).rows[0].total, null);
  assert.equal(f.store.report({ point: '6h' }).rows[0].samplingBlockedReason, 'publication_time_unverified');
  assert.equal(f.store.report({ point: '6h', sort: 'growth' }).rows.length, 0);
  assert.equal(f.store.dueMilestones().length, 0);
  const candidates = f.store.unverifiedRecentWorks({ accountId: 'a', since: at(0) });
  assert.deepEqual(candidates.map(item => [item.artworkId, item.publicationTimeVerified]), [['1', false]]);
  f.restart();
  assert.equal(f.store.report().rows[0].publicationTimeVerified, false);
  f.setTime(7.3);
  f.store.upsertWorks('a', [work('1', { publishedAt: at(1), publicationTimeVerified: true, createDateSource: 'pixiv-artwork-detail' })]);
  const fixed = f.store.report({ point: '6h', sort: 'growth' }).rows[0];
  assert.equal(fixed.targetAt, at(7)); assert.equal(fixed.observedAt, at(7.2)); assert.equal(fixed.growth, 20);
  assert.equal(fixed.publicationTimeVerified, true);
  assert.deepEqual(f.store.unverifiedRecentWorks({ accountId: 'a', since: at(0) }), []);
});

test('character and tag averages use each group and metric own valid work count, including real zero but excluding absent values', t => {
  const f = fixture(t, 6);
  const alpha = { key: 'alpha', name: 'Alpha' }, beta = { key: 'beta', name: 'Beta' };
  f.store.recordBatch('a', { works: [
    observed('1', 100, 10, null, { characters: [alpha], tags: ['red', 'shared'] }),
    observed('2', 300, null, null, { characters: [alpha, alpha, beta], tags: ['red', 'shared', 'shared'] }),
    observed('3', 900, 30, null, { characters: [beta], tags: ['blue', 'shared'] }),
    observed('4', null, null, 5, { characters: [alpha, beta], tags: ['red', 'blue', 'shared'] }),
    observed('5', 0, 0, null, { characters: [beta], tags: ['blue', 'shared'] }),
  ], observedAt: at(6) });
  f.store.recordBatch('b', { works: [observed('1', 10000, 100, null, { characters: [alpha], tags: ['red'] })], observedAt: at(6) });
  const roles = f.store.report({ accountIds: ['a'], group: 'character', sort: 'average' }).rows;
  assert.deepEqual(roles.map(row => [row.name, row.workCount, row.sampleCount, row.missingCount, row.total, row.average]),
    [['Beta', 4, 3, 1, 1200, 400], ['Alpha', 3, 2, 1, 400, 200]]);
  const tags = f.store.report({ accountId: 'a', group: 'tag', sort: 'average' }).rows;
  assert.deepEqual(tags.map(row => [row.name, row.workCount, row.sampleCount, row.average]),
    [['blue', 3, 2, 450], ['shared', 5, 4, 325], ['red', 3, 2, 200]]);
  const bookmarks = f.store.report({ accountId: 'a', group: 'character', metric: 'bookmarks', sort: 'average' }).rows;
  assert.deepEqual(bookmarks.map(row => [row.name, row.sampleCount, row.average]), [['Beta', 2, 15], ['Alpha', 1, 10]]);
  assert.deepEqual(bookmarks[0].metricSampleCounts, { views: 3, bookmarks: 2, likes: 1, bookmarkRate: 1 });
});

test('bounded artwork thumbnails persist per account without exposing remote URLs or losing valid URLs on absent or invalid refreshes', t => {
  const f = fixture(t, 6);
  const thumbnail = 'https://i.pximg.net/c/250x250_80_a2/img-master/img/2026/10/01/00/00/00/1_p0_square1200.jpg';
  f.store.recordBatch('a', { works: [observed('1', 10, null, null, { thumbnailUrl: thumbnail })], observedAt: at(6) });
  f.store.upsertWorks('b', [work('1')]);
  f.store.upsertWorks('a', [work('1'), work('2', { thumbnailUrl: thumbnail })]);
  f.store.upsertWorks('a', [work('1', { thumbnailUrl: 'https://evil.example/image.jpg' })]);
  f.restart();
  assert.equal(f.store.getWorkThumbnail({ accountId: 'a', artworkId: '1' }), thumbnail);
  assert.equal(f.store.getWorkThumbnail({ accountId: 'b', artworkId: '1' }), null);
  assert.equal(f.store.getWorkThumbnail({ accountId: 'a', artworkId: '2' }), null);
  assert.equal(f.store.getWorkThumbnail({ accountId: 'a', artworkId: '../1' }), null);
  assert.equal(f.store.getWorkThumbnail({ artworkId: '1' }), null);
  const report = f.store.report({ accountId: 'a' });
  assert.equal(report.rows.find(row => row.artworkId === '1').hasThumbnail, true);
  assert.equal(report.rows.find(row => row.artworkId === '2').hasThumbnail, false);
  assert.equal(JSON.stringify(report).includes('pximg.net'), false);
});

test('legacy databases gain thumbnail storage without losing observed metrics or the original collection cutoff', t => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'pixiv-analytics-migrate-'));
  const filename = path.join(dataDir, 'analytics.sqlite');
  const legacy = new DatabaseSync(filename);
  legacy.exec(`CREATE TABLE works(account_id TEXT NOT NULL,artwork_id TEXT NOT NULL,title TEXT NOT NULL,
    published_at TEXT,tags_json TEXT NOT NULL,characters_json TEXT NOT NULL,first_seen TEXT NOT NULL,last_seen TEXT NOT NULL,
    PRIMARY KEY(account_id,artwork_id));
    CREATE TABLE samples(id INTEGER PRIMARY KEY,account_id TEXT NOT NULL,artwork_id TEXT NOT NULL,observed_at TEXT NOT NULL,
    run_key TEXT NOT NULL,kind TEXT NOT NULL,views INTEGER,bookmarks INTEGER,likes INTEGER,UNIQUE(account_id,artwork_id,run_key));`);
  legacy.prepare('INSERT INTO works VALUES(?,?,?,?,?,?,?,?)').run('a', '1', 'Saved', START, '["tag"]', '[]', at(6), at(6));
  legacy.prepare('INSERT INTO samples VALUES(?,?,?,?,?,?,?,?,?)').run(1, 'a', '1', at(6), 'old', 'periodic', 42, 3, 2);
  legacy.close();
  const store = createAnalyticsStore({ filename, now: () => new Date(at(7)) });
  t.after(() => { store.close(); rmSync(dataDir, { recursive: true, force: true }); });
  assert.equal(store.report().rows[0].total, 42);
  assert.equal(store.report().rows[0].hasThumbnail, false);
  assert.equal(store.getEnabledAt('a'), at(6));
  const thumbnail = 'https://i.pximg.net/c/250x250_80_a2/img-master/img/2026/10/01/00/00/00/1_p0_square1200.jpg';
  store.upsertWorks('a', [{ artworkId: '1', thumbnailUrl: thumbnail }]);
  assert.equal(store.getWorkThumbnail({ accountId: 'a', artworkId: '1' }), thumbnail);
  assert.equal(store.report().rows[0].title, 'Saved');
  assert.equal(store.report().rows[0].total, 42);
});

test('publication date windows filter works before group averages and pagination, with inclusive rolling boundaries and unfiltered account history', t => {
  const f = fixture(t, 400 * 24);
  f.store.recordBatch('a', { account: { views: 0 }, observedAt: at(0), runId: 'enable' });
  const catalog = [[10, 1000], [35, 20], [220, 40], [310, 80], [370, 100], [399, 200]];
  f.store.recordBatch('a', { works: catalog.map(([day, value]) => observed(String(day), value, null, null,
    { publishedAt: at(day * 24), publicationTimeVerified: true })).concat([
    observed('missing', null, null, 1, { publishedAt: at(399 * 24), publicationTimeVerified: true }),
    observed('unknown', 9000, null, null, { publishedAt: null }),
    observed('future', 10000, null, null, { publishedAt: at(401 * 24) }),
  ]), account: { views: 12000 }, observedAt: at(400 * 24), runId: 'current' });
  for (const [days, workCount, sampleCount, average] of [['30', 3, 2, 150], ['90', 4, 3, 380 / 3], ['180', 5, 4, 105], ['365', 6, 5, 88]]) {
    const result = f.store.report({ days, group: 'character', sort: 'average' });
    assert.equal(result.filters.days, days);
    assert.equal(result.rows[0].workCount, workCount); assert.equal(result.rows[0].sampleCount, sampleCount);
    assert.equal(result.rows[0].average, average);
    assert.equal(result.summary.totalTrackedWorkCount, workCount);
    assert.equal(result.summary.excludedByDateCount, 9 - workCount);
    assert.equal(result.accounts[0].history.length, 2); assert.equal(result.accounts[0].history[0].observedAt, at(0));
  }
  const page = f.store.report({ days: 30, limit: 1, offset: 1 });
  assert.equal(page.pagination.total, 3); assert.equal(page.rows[0].artworkId, '370');
  assert.equal(f.store.report().pagination.total, 9);
  assert.equal(f.store.report({ days: 'invalid' }).filters.days, 'all');
  for (const day of [220, 370, 399]) f.store.recordBatch('a', { works: [observed(String(day), 60)],
    observedAt: at(day * 24 + 6), runId: `six-${day}` });
  // Metadata refreshes above preserve the verified publication times.
  const intervals = f.store.report({ group: 'interval', days: '30', point: '6h' });
  assert.deepEqual(intervals.rows.map(row => row.artworkId).sort(), ['370', '399', 'missing']);
  assert.equal(intervals.summary.sampledWorkCount, 2);
  f.setTime(400 * 24 + 0.001);
  assert.equal(f.store.report({ days: 30 }).rows.some(row => row.artworkId === '370'), false);
});

test('interval rates use adjacent actual milestone observations, with an explicitly estimated publication baseline only for 0–6 hours', t => {
  const f = fixture(t);
  f.store.recordBatch('a', { account: { views: 0 }, observedAt: at(0), runId: 'enable' });
  const thumbnail = 'https://i.pximg.net/c/250x250_80_a2/img-master/img/2026/10/01/00/00/00/1_p0_square1200.jpg';
  const times = [7.1, 13.4, 25.2, 169.3], values = [61, 187, 423, 3305], points = ['6h', '12h', '24h', '7d'];
  for (let i = 0; i < points.length; i++) {
    f.setTime(times[i]);
    f.store.recordBatch('a', { works: [observed('1', values[i], 10 * i, i, { publishedAt: at(1),
      publicationTimeVerified: true, thumbnailUrl: thumbnail })], observedAt: at(times[i]), runId: points[i] });
    const result = f.store.report({ group: 'interval', point: points[i] }), row = result.rows[0];
    const start = i ? times[i - 1] : 1, delta = values[i] - (i ? values[i - 1] : 0);
    assert.equal(result.filters.sort, 'growth'); assert.equal(row.status, 'recorded');
    assert.equal(row.delta, delta); assert.equal(row.total, delta); assert.equal(row.average, delta);
    assert.ok(Math.abs(row.intervalHours - (times[i] - start)) < 1e-9);
    assert.ok(Math.abs(row.growth - (i ? 20 : 10)) < 1e-9);
    assert.equal(row.intervalStartAt, at(start)); assert.equal(row.intervalEndAt, at(times[i]));
    assert.equal(row.fromObservedAt, i ? at(start) : null); assert.equal(row.toObservedAt, at(times[i]));
    assert.equal(row.baselineKind, i ? 'milestone_observation' : 'publication_zero_estimate');
    assert.equal(row.interval.fromPoint, i ? points[i - 1] : 'publication'); assert.equal(row.interval.toPoint, points[i]);
    assert.equal(row.positiveGrowth, true); assert.equal(row.hasThumbnail, true);
  }
  f.restart();
  assert.equal(f.store.report({ group: 'interval', point: '12h' }).rows[0].delta, 126);
  assert.equal(f.store.report({ group: 'interval', point: 'current' }).filters.point, '6h');
  assert.equal(f.store.status().sampleCount, 4);
});

test('interval rankings retain missing and pending new works, preserve counter decreases, and exclude history and unverified dates', t => {
  const f = fixture(t);
  f.store.recordBatch('a', { account: { views: 0 }, observedAt: at(0), runId: 'enable' });
  const make = (id, views, changes = {}) => observed(id, views, 1, null, { publishedAt: at(1), publicationTimeVerified: true, ...changes });
  f.store.recordBatch('a', { works: [make('historical', 100, { publishedAt: at(-1) })], observedAt: at(5), runId: 'old-six' });
  f.store.recordBatch('a', { works: [make('rise', 100), make('fall', 100), make('metric-missing', null), make('end-missing', 1)], observedAt: at(7), runId: 'six' });
  f.store.recordBatch('a', { works: [make('pending-end', 80, { publishedAt: at(2) })], observedAt: at(8), runId: 'pending-six' });
  f.store.recordBatch('a', { works: [make('rise', 160), make('fall', 80), make('start-missing', 30), make('metric-missing', 40)], observedAt: at(13), runId: 'twelve' });
  f.store.upsertWorks('a', [work('pending-start', { publishedAt: at(10), publicationTimeVerified: true }),
    work('provisional', { publishedAt: at(1), publicationTimeVerified: false }), work('legacy', { publishedAt: at(1) })]);
  f.setTime(13.6);
  const result = f.store.report({ group: 'interval', point: '12h' }), byId = Object.fromEntries(result.rows.map(row => [row.artworkId, row]));
  assert.equal(result.pagination.total, 7); assert.equal(result.rows[0].artworkId, 'rise');
  assert.equal(byId.fall.delta, -20); assert.equal(byId.fall.growth, -20 / 6);
  assert.equal(byId.fall.counterDecreased, true); assert.equal(byId.fall.positiveGrowth, false); assert.equal(byId.fall.status, 'recorded');
  assert.equal(byId['start-missing'].missingReason, 'start_milestone_missing');
  assert.equal(byId['end-missing'].missingReason, 'end_milestone_missing');
  assert.equal(byId['metric-missing'].missingReason, 'start_metric_missing');
  assert.equal(byId['pending-end'].missingReason, 'end_milestone_pending');
  assert.equal(byId['pending-start'].missingReason, 'start_milestone_pending');
  assert.equal(byId['start-missing'].growth, null); assert.equal(byId['pending-end'].delta, null);
  assert.equal(result.summary.workCount, 7); assert.equal(result.summary.sampledWorkCount, 2);
  assert.equal(result.summary.missingWorkCount, 3); assert.equal(result.summary.pendingWorkCount, 2);
  assert.equal(result.summary.positiveGrowthWorkCount, 1); assert.equal(result.summary.excludedHistoricalCount, 1);
  assert.equal(f.store.report({ group: 'interval', point: '12h', accountIds: [] }).pagination.total, 0);
  const searched = f.store.report({ group: 'interval', point: '12h', query: 'fall', limit: 1 });
  assert.equal(searched.pagination.total, 1); assert.equal(searched.rows[0].artworkId, 'fall');
});

test('account totals sum one latest sample per tracked work independently of all ranking filters', t => {
  const f = fixture(t, 2000);
  f.store.recordBatch('a', { works: [observed('old', 100, 10, 5)], observedAt: at(6), runId: 'early' });
  f.store.recordBatch('a', { works: [observed('old', 200, 20, null)], observedAt: at(12), runId: 'latest-old' });
  f.store.recordBatch('a', { works: [observed('recent', 0, null, 3, { publishedAt: at(1950), publicationTimeVerified: true })], observedAt: at(1960), runId: 'recent' });
  f.store.recordBatch('a', { works: [observed('recent', null, null, null)], observedAt: at(1970), runId: 'failed' });
  f.store.upsertWorks('a', [work('unsampled', { publishedAt: null })]);
  f.store.recordBatch('a', { account: { views: 1000, followers: 50 }, observedAt: at(1999), runId: 'account' });
  const expected = { views: 200, bookmarks: 20, likes: 3, workCount: 3,
    metricCounts: { views: 2, bookmarks: 1, likes: 1 }, observedAt: at(1960) };
  const sampleCount = f.store.status().sampleCount;
  for (const options of [{},
    { days: 30, group: 'character', metric: 'likes', sort: 'average', query: 'no-match', limit: 1, offset: 50 },
    { days: 90, group: 'tag', point: '6h', metric: 'bookmarks', sort: 'growth', historyLimit: 1 },
    { days: 180, group: 'interval', point: '12h', query: 'absent', limit: 1 },
    { days: 365, group: 'work', point: '7d', sort: 'total' }]) {
    const result = f.store.report({ accountId: 'a', ...options });
    assert.deepEqual(result.accounts[0].totals, expected);
    assert.equal(result.accounts[0].latest.views, 1000);
    assert.equal(result.accounts[0].latest.followers, 50);
  }
  assert.equal(f.store.status().sampleCount, sampleCount);
});

test('account totals distinguish absent metrics from zero and include accounts without tracked works', t => {
  const f = fixture(t, 6);
  f.store.recordBatch('account-only', { account: { followers: 7 }, observedAt: at(6) });
  f.store.upsertWorks('unsampled', [work('1')]);
  f.store.recordBatch('zero', { works: [observed('1', 0, 0, 0)], observedAt: at(6) });
  f.store.recordBatch('partial', { works: [observed('1', 10)], observedAt: at(6) });
  const accounts = Object.fromEntries(f.store.report().accounts.map(account => [account.accountId, account.totals]));
  const empty = { views: null, bookmarks: null, likes: null, workCount: 0,
    metricCounts: { views: 0, bookmarks: 0, likes: 0 }, observedAt: null };
  assert.deepEqual(accounts['account-only'], empty);
  assert.deepEqual(accounts.unsampled, { ...empty, workCount: 1 });
  assert.deepEqual(accounts.zero, { views: 0, bookmarks: 0, likes: 0, workCount: 1,
    metricCounts: { views: 1, bookmarks: 1, likes: 1 }, observedAt: at(6) });
  assert.deepEqual(accounts.partial, { views: 10, bookmarks: null, likes: null, workCount: 1,
    metricCounts: { views: 1, bookmarks: 0, likes: 0 }, observedAt: at(6) });
});

test('account totals honor account allowlists and report time, use the latest tie, and remain stable across restart', t => {
  const f = fixture(t, 12);
  f.store.recordBatch('a', { works: [observed('1', 10, 1, 2)], observedAt: at(6), runId: 'early' });
  f.store.recordBatch('a', { works: [observed('1', 20, null, 4)], observedAt: at(12), runId: 'first-tie' });
  f.store.recordBatch('a', { works: [observed('1', 30, 3, null)], observedAt: at(12), runId: 'last-tie' });
  f.store.recordBatch('a', { works: [observed('1', 999, 99, 99)], observedAt: at(18), runId: 'future' });
  f.store.recordBatch('b', { works: [observed('1', 900, 90, 90)], observedAt: at(12), runId: 'other-account' });
  f.restart();
  const current = f.store.report({ accountIds: ['a'] });
  assert.equal(current.accounts.length, 1); assert.equal(current.accounts[0].accountId, 'a');
  assert.deepEqual(current.accounts[0].totals, { views: 30, bookmarks: 3, likes: null, workCount: 1,
    metricCounts: { views: 1, bookmarks: 1, likes: 0 }, observedAt: at(12) });
  assert.deepEqual(f.store.report({ accountIds: [] }).accounts, []);
  assert.deepEqual(f.store.report({ accountIds: ['a'], accountId: 'b' }).accounts, []);
  const early = f.store.report({ accountId: 'a', now: at(6) }).accounts[0].totals;
  assert.equal(early.views, 10); assert.equal(early.bookmarks, 1); assert.equal(early.likes, 2); assert.equal(early.observedAt, at(6));
  f.setTime(18);
  assert.equal(f.store.report({ accountId: 'a' }).accounts[0].totals.views, 999);
  assert.equal(f.store.report({ accountId: 'b' }).accounts[0].totals.views, 900);
});

const dailySources = { viewCount: { section: 'access', scope: 'cumulative', surface: 'report-top-summary' },
  followerCount: { seriesId: 'pixiv-followers-page-total-v1' } };
function dailyCycle(f, accountId, hours, runId, works, account) {
  f.store.recordBatch(accountId, { works, account: account && { ...account, sources: account.sources || dailySources },
    observedAt: at(hours), runId, kind: 'periodic' });
  return f.store.completePeriodicRun(accountId, { runId, completedAt: at(hours), expectedWorkCount: works.length });
}

test('daily changes use Beijing midnight and actual latest endpoints, preserving negative values and independent ranking filters', t => {
  const f = fixture(t, 16);
  for (const [hours, views, bookmarks, likes, followers] of [[10, 80, 8, 3, 21], [14, 100, 10, 5, 20], [16, 200, 15, 8, 19]]) {
    assert.equal(dailyCycle(f, 'a', hours, `r${hours}`, [observed('1', views, bookmarks, likes)], { views, followers }), true);
  }
  const baseline = f.store.report({ accountId: 'a' }).accounts[0].daily;
  assert.equal(baseline.timezone, 'Asia/Shanghai'); assert.equal(baseline.days, '30');
  assert.deepEqual(baseline.rows.map(row => row.date), ['2026-10-02', '2026-10-01']);
  assert.deepEqual(Object.values(baseline.today.metrics).map(metric => metric.delta), [100, 5, 3, -1]);
  for (const metric of Object.values(baseline.today.metrics)) {
    assert.equal(metric.status, 'complete'); assert.equal(metric.startAt, at(14)); assert.equal(metric.endAt, at(16));
  }
  assert.equal(baseline.rows[1].metrics.views.status, 'partial'); assert.equal(baseline.rows[1].metrics.views.delta, 20);
  assert.deepEqual(f.store.report({ days: '30', group: 'interval', point: '7d', query: 'absent', limit: 1, offset: 99 }).accounts[0].daily, baseline);
  const beforeMidnight = f.store.report({ now: at(15.999) }).accounts[0].daily;
  assert.equal(beforeMidnight.today.date, '2026-10-01'); assert.equal(beforeMidnight.today.metrics.views.endValue, 100);
  f.restart(); assert.deepEqual(f.store.report().accounts[0].daily, baseline);
});

test('daily gaps stay missing instead of becoming cross-day or first-day growth, with explicit zero and bounded date choices', t => {
  const f = fixture(t, 50);
  for (const [hours, views] of [[1, 0], [49, 10], [50, 20]]) f.store.recordBatch('a', {
    account: { views, followers: 0, sources: dailySources }, observedAt: at(hours), runId: `a${hours}` });
  const daily = f.store.report({ dailyDays: '7' }).accounts[0].daily;
  assert.equal(daily.days, '7'); assert.equal(daily.rows.length, 3);
  assert.equal(daily.today.metrics.views.reason, 'previous_day_missing');
  assert.equal(daily.rows[1].metrics.views.reason, 'no_observation');
  assert.equal(daily.rows[2].metrics.views.endValue, 0); assert.equal(daily.rows[2].metrics.views.reason, 'first_observation_only');
  f.store.upsertWorks('empty', [work('1')]);
  assert.equal(f.store.report({ accountId: 'empty' }).accounts[0].daily.rows.length, 1);
  f.store.recordBatch('old', { account: { views: 0 }, observedAt: at(-10000), runId: 'first' });
  for (const days of ['7', '30', '90', '365']) assert.equal(f.store.report({ accountId: 'old', dailyDays: days }).accounts[0].daily.rows.length, Number(days));
  assert.equal(f.store.report({ accountId: 'old', dailyDays: 'all' }).accounts[0].daily.days, '30');
});

test('daily account metrics isolate sources and latest timestamp ties without treating missing followers as zero', t => {
  const f = fixture(t, 14);
  const add = (accountId, hours, followers, sources, runId) => f.store.recordBatch(accountId, {
    account: { views: 100, followers, sources }, observedAt: at(hours), runId });
  add('a', 10, 999, { viewCount: dailySources.viewCount }, 'old-followers');
  add('a', 12, 10, dailySources, 'first-tie'); add('a', 12, 12, dailySources, 'last-tie'); add('a', 14, 9, dailySources, 'end');
  let metric = f.store.report({ accountId: 'a' }).accounts[0].daily.today.metrics.followers;
  assert.equal(metric.delta, -3); assert.equal(metric.startAt, at(12)); assert.equal(metric.startValue, 12); assert.equal(metric.status, 'partial');
  f.setTime(16); add('a', 16, 999, { followerCount: { seriesId: 'legacy' } }, 'changed');
  assert.equal(f.store.report({ accountId: 'a' }).accounts[0].daily.today.metrics.followers.reason, 'unsupported_source');
  f.setTime(17); add('a', 17, null, dailySources, 'missing');
  assert.equal(f.store.report({ accountId: 'a' }).accounts[0].daily.today.metrics.followers.reason, 'metric_missing');
  add('b', 10, 1, {}, 'unknown'); add('b', 14, 1, dailySources, 'known');
  assert.equal(f.store.report({ accountId: 'b', now: at(14) }).accounts[0].daily.today.metrics.views.reason, 'source_changed');
  add('b', 16, 1, { ...dailySources, viewCount: { ...dailySources.viewCount, scope: 'weekly' } }, 'new-scope');
  assert.equal(f.store.report({ accountId: 'b' }).accounts[0].daily.today.metrics.views.reason, 'source_changed');
  assert.equal(f.store.report({ accountIds: ['a'] }).accounts.length, 1);
});

test('daily periodic totals require completion, full metric coverage and short observations; milestones and failed cycles never fill gaps', t => {
  const f = fixture(t, 14);
  assert.equal(dailyCycle(f, 'a', 8, 'first', [observed('1', 1, 8, 3), observed('2', 1, 16, 6)]), true);
  assert.equal(dailyCycle(f, 'a', 10, 'second', [observed('1', 2, 10, 5), observed('2', 2, 20, null)]), true);
  assert.equal(f.store.completePeriodicRun('a', { runId: 'second', completedAt: at(10), expectedWorkCount: 2 }), true);
  f.store.recordBatch('a', { works: [observed('1', 100, 100, 100), observed('2', 100, 100, 100)], observedAt: at(12), runId: 'unmarked' });
  f.store.recordBatch('a', { works: [observed('1', 900, 900, 900)], observedAt: at(14), runId: 'milestone', kind: 'milestone' });
  const daily = f.store.report().accounts[0].daily;
  assert.equal(daily.today.metrics.bookmarks.delta, 6); assert.equal(daily.today.metrics.bookmarks.endAt, at(10));
  assert.equal(daily.today.metrics.likes.reason, 'incomplete_snapshot');
  assert.equal(f.store.completePeriodicRun('a', { runId: 'milestone', completedAt: at(14), expectedWorkCount: 2 }), false);
  assert.equal(f.store.completePeriodicRun('empty', { runId: 'zero', completedAt: at(14), expectedWorkCount: 0 }), false);
  f.store.recordBatch('a', { works: [observed('1', 3, 30, 30)], observedAt: at(15), runId: 'long' });
  f.store.recordBatch('a', { works: [observed('2', 3, 30, 30)], observedAt: at(22), runId: 'long' });
  assert.equal(f.store.completePeriodicRun('a', { runId: 'long', completedAt: at(22), expectedWorkCount: 2 }), false);
  f.setTime(22); assert.equal(f.store.report().accounts[0].daily.today.metrics.bookmarks.reason, 'observation_span');
  f.restart(); assert.equal(f.store.completePeriodicRun('a', { runId: 'long', completedAt: at(22), expectedWorkCount: 2 }), false);
});

test('daily first-day partial baselines skip archive backfill, while genuine new publications may join and later-day scope changes remain missing', t => {
  const f = fixture(t, 14);
  assert.equal(dailyCycle(f, 'a', 8, 'subset', [observed('1', 1, 10, 10)]), true);
  const pair = value => [observed('1', 1, value, value), observed('2', 1, 100, 100)];
  assert.equal(dailyCycle(f, 'a', 10, 'backfilled', pair(11)), true);
  assert.equal(f.store.report().accounts[0].daily.today.metrics.bookmarks.reason, 'scope_changed');
  assert.equal(dailyCycle(f, 'a', 14, 'comparable', pair(15)), true);
  let metric = f.store.report().accounts[0].daily.today.metrics.bookmarks;
  assert.equal(metric.status, 'partial'); assert.equal(metric.startAt, at(10)); assert.equal(metric.delta, 4);
  const withNew = [...pair(20), observed('3', 1, 5, 5, { publishedAt: at(16), publicationTimeVerified: true })];
  f.setTime(18); assert.equal(dailyCycle(f, 'a', 18, 'new-publication', withNew), true);
  metric = f.store.report().accounts[0].daily.today.metrics.bookmarks;
  assert.equal(metric.status, 'complete'); assert.equal(metric.delta, 10);
  f.setTime(20); assert.equal(dailyCycle(f, 'a', 20, 'late-old', [...withNew, observed('4', 1, 1000, 1000)]), true);
  metric = f.store.report().accounts[0].daily.today.metrics.bookmarks;
  assert.equal(metric.status, 'missing'); assert.equal(metric.reason, 'scope_changed');
});

test('legacy and new uncompleted cycles are never inferred; only explicitly verified legacy cycles enter daily history', t => {
  const f = fixture(t, 14);
  f.store.recordBatch('a', { works: [observed('1', 1, 10, 10)], observedAt: at(10), runId: 'old-first' });
  f.store.recordBatch('a', { works: [observed('1', 1, 15, 15)], observedAt: at(14), runId: 'old-second' });
  f.store.recordBatch('a', { works: [observed('1', 1, 900, 900)], observedAt: at(15), runId: 'old-active' });
  f.store.setMeta('collector:v1', { accounts: { a: { cycle: { id: 'old-active' } } } });
  f.restart();
  let daily = f.store.report().accounts[0].daily;
  assert.equal(daily.today.metrics.bookmarks.reason, 'no_observation');
  for (const [runId, hours] of [['old-first', 10], ['old-second', 14]]) assert.equal(f.store.completePeriodicRun('a', {
    runId, completedAt: at(hours), expectedWorkCount: 1, origin: 'verified_legacy' }), true);
  daily = f.store.report().accounts[0].daily;
  assert.equal(daily.today.metrics.bookmarks.delta, 5);
  f.setTime(15.5);
  f.store.recordBatch('a', { works: [observed('1', 1, 1000, 1000)], observedAt: at(15.5), runId: 'new-uncompleted' });
  f.restart(); daily = f.store.report().accounts[0].daily;
  assert.equal(daily.today.metrics.bookmarks.endAt, at(14)); assert.equal(daily.today.metrics.bookmarks.delta, 5);
  assert.equal(f.store.completePeriodicRun('a', { runId: 'old-active', completedAt: at(15), expectedWorkCount: 1 }), true);
  assert.equal(f.store.report().accounts[0].daily.today.metrics.bookmarks.endAt, at(15));
});

test('deleting a remote artwork breaks the scope boundary once but does not prevent later daily snapshots from completing', t => {
  const f = fixture(t, 14);
  assert.equal(dailyCycle(f, 'a', 14, 'before-delete', [observed('1', 1, 10, 10), observed('2', 1, 20, 20)]), true);
  f.setTime(18);
  assert.equal(dailyCycle(f, 'a', 18, 'after-delete', [observed('1', 1, 15, 15)]), true);
  assert.equal(f.store.status().workCount, 2);
  assert.equal(f.store.report().accounts[0].daily.today.metrics.bookmarks.reason, 'scope_changed');
  f.setTime(42);
  assert.equal(dailyCycle(f, 'a', 42, 'stable-scope', [observed('1', 1, 25, 25)]), true);
  const metric = f.store.report().accounts[0].daily.today.metrics.bookmarks;
  assert.equal(metric.status, 'complete'); assert.equal(metric.delta, 10); assert.equal(metric.startAt, at(18));
});

test('periodic snapshots with equal observation times use the latest sample even when completion markers arrive in reverse order', t => {
  const f = fixture(t, 16);
  for (const [runId, hours, value] of [['earlier', 14, 10], ['later', 14, 20], ['today', 16, 30]]) {
    f.store.recordBatch('a', { works: [observed('1', 1, value, value)], observedAt: at(hours), runId });
  }
  for (const [runId, hours] of [['later', 14], ['earlier', 14], ['today', 16]]) {
    assert.equal(f.store.completePeriodicRun('a', { runId, completedAt: at(hours), expectedWorkCount: 1 }), true);
  }
  const metric = f.store.report().accounts[0].daily.today.metrics.bookmarks;
  assert.equal(metric.startValue, 20); assert.equal(metric.delta, 10); assert.equal(metric.status, 'complete');
});

test('all work rows expose independent counts and bookmark ratios, distinguishing zero from unavailable denominators and sorting before pagination', t => {
  const f = fixture(t, 6);
  f.store.recordBatch('a', { works: [observed('valid', 100, 25, 3), observed('zero-zero', 0, 0, 0),
    observed('zero-views', 0, 3, null), observed('missing-views', null, 5, null), observed('missing-bookmarks', 100, null, 5),
    observed('zero-bookmarks', 100, 0, 1), observed('high', 50, 100, null), observed('empty', null, null, null)], observedAt: at(6) });
  const result = f.store.report({ metric: 'bookmarkRate', sort: 'growth' });
  assert.equal(result.filters.sort, 'total'); assert.equal(result.pagination.total, 8);
  assert.deepEqual(result.rows.slice(0, 3).map(row => [row.artworkId, row.total]), [['high', 2], ['valid', .25], ['zero-bookmarks', 0]]);
  const byId = Object.fromEntries(result.rows.map(row => [row.artworkId, row]));
  for (const id of ['zero-zero', 'zero-views', 'missing-views', 'missing-bookmarks', 'empty']) {
    assert.equal(byId[id].metrics.bookmarkRate, null); assert.equal(byId[id].sampleCount, 0);
    assert.equal(byId[id].metricSampleCounts.bookmarkRate, 0);
  }
  assert.equal(byId.valid.average, null); assert.equal(byId.valid.growth, null);
  assert.equal(byId.valid.averageMetrics.views, 100); assert.equal(byId.valid.averageMetrics.bookmarkRate, null);
  assert.equal(byId['zero-bookmarks'].sampleCount, 1);
  assert.deepEqual(byId.valid.metrics, { views: 100, bookmarks: 25, likes: 3, bookmarkRate: .25 });
  assert.equal(f.store.report({ metric: 'likes' }).rows.find(row => row.artworkId === 'valid').metrics.bookmarkRate, .25);
  const page = f.store.report({ metric: 'bookmarkRate', sort: 'average', limit: 1, offset: 1 });
  assert.equal(page.rows[0].artworkId, 'valid'); assert.equal(page.filters.sort, 'total'); assert.equal(page.pagination.total, 8);
  assert.equal(f.store.report({ metric: 'bookmarkRate', query: 'zero-bookmarks', limit: 1 }).rows[0].total, 0);
});

test('group bookmark rates weight the same valid work pairs while count totals and averages retain their own independent coverage', t => {
  const f = fixture(t, 6), alpha = [{ key: 'alpha', name: 'Alpha' }], beta = [{ key: 'beta', name: 'Beta' }];
  const grouped = (id, views, bookmarks, likes) => observed(id, views, bookmarks, likes, { characters: alpha, tags: ['A', 'A'] });
  f.store.recordBatch('a', { works: [grouped('1', 10, 5, 2), grouped('2', 90, 9, null), grouped('3', 1000, null, 0),
    grouped('4', null, 1000, 8), grouped('5', 0, 50, null), grouped('6', 100, 0, 1),
    observed('7', 100, 8, 3, { characters: beta, tags: ['B'] })], observedAt: at(6) });
  for (const group of ['character', 'tag']) {
    const result = f.store.report({ group, metric: 'bookmarkRate', sort: 'average' });
    assert.equal(result.filters.sort, 'total'); assert.equal(result.rows[0].total, .08);
    const row = result.rows[1];
    assert.equal(row.total, 14 / 200); assert.equal(row.metrics.bookmarkRate, 14 / 200);
    assert.equal(row.metrics.views, 1200); assert.equal(row.metrics.bookmarks, 1064); assert.equal(row.metrics.likes, 11);
    assert.equal(row.workCount, 6); assert.equal(row.sampleCount, 3); assert.equal(row.missingCount, 3);
    assert.deepEqual(row.metricSampleCounts, { views: 5, bookmarks: 5, likes: 4, bookmarkRate: 3 });
    assert.deepEqual(row.averageMetrics, { views: 240, bookmarks: 1064 / 5, likes: 11 / 4, bookmarkRate: null });
    assert.deepEqual(row.growthMetrics, { views: null, bookmarks: null, likes: null, bookmarkRate: null });
    assert.equal(row.average, null); assert.equal(row.growth, null);
  }
  const page = f.store.report({ group: 'tag', metric: 'bookmarkRate', limit: 1, offset: 1 });
  assert.equal(page.rows[0].name, 'A'); assert.equal(page.pagination.total, 2);
});

test('all grouped growth columns average per-work rates with a separate valid denominator for each count metric', t => {
  const f = fixture(t);
  f.store.recordBatch('a', { account: { views: 0 }, observedAt: at(0), runId: 'enable' });
  f.setTime(7.1);
  f.store.recordBatch('a', { works: [observed('1', 61, 0, null, { publishedAt: at(1) }),
    observed('2', 122, null, 61, { publishedAt: at(1) }), observed('3', null, 61, 122, { publishedAt: at(1) })], observedAt: at(7.1) });
  for (const metric of ['views', 'bookmarks', 'likes', 'bookmarkRate']) {
    const row = f.store.report({ group: 'character', point: '6h', metric, sort: 'growth' }).rows[0];
    assert.deepEqual(row.metrics, { views: 183, bookmarks: 61, likes: 183, bookmarkRate: 0 });
    assert.deepEqual(row.averageMetrics, { views: 91.5, bookmarks: 30.5, likes: 91.5, bookmarkRate: null });
    assert.deepEqual(row.growthMetrics, { views: 15, bookmarks: 5, likes: 15, bookmarkRate: null });
    assert.deepEqual(row.metricSampleCounts, { views: 2, bookmarks: 2, likes: 2, bookmarkRate: 1 });
    assert.deepEqual(row.growthMetricSampleCounts, { views: 2, bookmarks: 2, likes: 2, bookmarkRate: 0 });
    assert.equal(row.growth, metric === 'bookmarkRate' ? null : metric === 'bookmarks' ? 5 : 15);
  }
});

test('interval ratios use only cumulative endpoint pairs even when a start node or individual count deltas are missing', t => {
  const f = fixture(t);
  f.store.recordBatch('a', { account: { views: 0 }, observedAt: at(0), runId: 'enable' });
  const make = (id, views, bookmarks, likes) => observed(id, views, bookmarks, likes,
    { publishedAt: at(1), publicationTimeVerified: true });
  f.store.recordBatch('a', { works: [make('partial-start', null, 5, 10), make('full', 100, 10, 5)], observedAt: at(7), runId: 'six' });
  f.store.recordBatch('a', { works: [make('no-start', 100, 25, null), make('partial-start', 100, 20, 20), make('full', 200, 20, 11),
    make('zero-end', 0, 2, 1)], observedAt: at(13), runId: 'twelve' });
  f.store.upsertWorks('a', [work('pending', { publishedAt: at(1), publicationTimeVerified: true })]);
  f.setTime(13);
  const result = f.store.report({ group: 'interval', point: '12h', metric: 'bookmarkRate', sort: 'growth' });
  assert.equal(result.filters.sort, 'total');
  assert.deepEqual(result.rows.slice(0, 3).map(row => [row.artworkId, row.total]), [['no-start', .25], ['partial-start', .2], ['full', .1]]);
  const byId = Object.fromEntries(result.rows.map(row => [row.artworkId, row]));
  assert.equal(byId['no-start'].status, 'recorded'); assert.equal(byId['no-start'].missingReason, null);
  assert.equal(byId['no-start'].sampleCount, 1); assert.equal(byId['no-start'].fromObservedAt, null);
  assert.equal(byId['no-start'].deltaMetrics.views, null); assert.equal(byId['no-start'].growthMetrics.bookmarks, null);
  assert.equal(byId['partial-start'].deltaMetrics.views, null); assert.equal(byId['partial-start'].deltaMetrics.bookmarks, 15);
  assert.equal(byId['partial-start'].growthMetrics.bookmarks, 2.5); assert.equal(byId['partial-start'].growthMetrics.likes, 10 / 6);
  for (const row of result.rows) { assert.equal(row.delta, null); assert.equal(row.average, null); assert.equal(row.growth, null); assert.equal(row.growthMetrics.bookmarkRate, null); }
  assert.equal(byId['zero-end'].total, null); assert.equal(byId['zero-end'].sampleCount, 0); assert.equal(byId['zero-end'].missingReason, 'end_metric_missing');
  assert.equal(byId.pending.status, 'pending'); assert.equal(byId.pending.missingReason, 'end_milestone_pending');
  assert.equal(result.summary.sampledWorkCount, 3); assert.equal(result.summary.missingWorkCount, 1); assert.equal(result.summary.pendingWorkCount, 1);
  const fullCount = f.store.report({ group: 'interval', point: '12h', metric: 'views', sort: 'total' }).rows.find(row => row.artworkId === 'full');
  assert.equal(fullCount.total, 100); assert.equal(fullCount.growth, 100 / 6); assert.equal(fullCount.metrics.views, 200);
  assert.equal(fullCount.metrics.bookmarkRate, .1); assert.equal(fullCount.deltaMetrics.bookmarks, 10);
  assert.deepEqual(fullCount.deltaMetricSampleCounts, { views: 1, bookmarks: 1, likes: 1, bookmarkRate: 0 });
  assert.equal(f.store.report({ group: 'interval', point: '12h', metric: 'bookmarkRate', limit: 1, offset: 1 }).rows[0].artworkId, 'partial-start');
});
