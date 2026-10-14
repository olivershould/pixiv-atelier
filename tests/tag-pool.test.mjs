import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTagPools } from '../server/tag-pool.mjs';

const scope = { mode: 'live', accountId: 'first', pixivUserId: '123' };
const checkedAt = '2026-10-13T01:00:00.000Z';
const remote = (extra = {}) => ({ pixivUserId: '123', checkedAt, frequentTags: ['原神', '女の子'], recentWorks: [{ artworkId: '42', title: 'Mona', tags: ['原神', 'おへそ'] }], ...extra });
async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pixiv-tag-pool-'));
  t.after(async () => { assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir())); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { dataDir, pool: await createTagPools({ dataDir }) };
}

test('tag pools persist manual pins, normalized removals, and account/mode/identity isolation', async t => {
  const { dataDir, pool } = await fixture(t);
  await pool.sync(scope, remote());
  let result = await pool.edit(scope, { addTags: ['Ｍｏｎａ', 'mona'], removeTags: ['原神'] });
  assert.deepEqual(result.tags, ['Mona', '女の子', 'おへそ']);
  assert.deepEqual(result.manualTags, ['Mona']);
  result = await pool.sync(scope, remote({ frequentTags: ['原神', '女の子', '白髪'] }));
  assert.deepEqual(result.tags, ['Mona', '女の子', '白髪', 'おへそ']);
  assert.equal(result.cached, false);
  assert.deepEqual(pool.get({ ...scope, accountId: 'second' }).tags, []);
  assert.deepEqual(pool.get({ ...scope, mode: 'demo' }).tags, []);
  assert.deepEqual(pool.get({ ...scope, pixivUserId: '456' }).tags, []);
  const reloaded = await createTagPools({ dataDir });
  assert.deepEqual(reloaded.get(scope).tags, result.tags);
  assert.equal(reloaded.get(scope).checkedAt, checkedAt);
  assert.deepEqual((await reloaded.edit(scope, { addTags: ['原神'] })).tags, ['Mona', '原神', '女の子', '白髪', 'おへそ']);
});

test('only prior remote evidence proves cached labels; local completed works seed preferences but drafts never do', async t => {
  const { pool } = await fixture(t);
  const jobs = [
    { accountId: 'first', status: 'draft', tagsConfirmed: true, tags: ['DraftGuess'] },
    { accountId: 'first', pixivUserId: '123', status: 'reserved', tagsConfirmed: true, tags: ['ReservationGuess'] },
    { accountId: 'first', pixivUserId: '123', status: 'failed', tagsConfirmed: true, tags: ['FailedGuess'] },
    { accountId: 'first', status: 'published', tagsConfirmed: false, tags: ['Unconfirmed'] },
    { accountId: 'other', status: 'published', tagsConfirmed: true, tags: ['OtherAccount'] },
    { accountId: 'first', pixivUserId: '123', status: 'published', tagsConfirmed: true, tags: ['ManualHistory'] },
    { accountId: 'first', pixivUserId: '456', status: 'published', tagsConfirmed: true, tags: ['OldBinding'] },
    { accountId: 'first', status: 'published', tagsConfirmed: true, tags: ['UnboundHistory'] },
  ];
  assert.deepEqual(pool.get(scope, { jobs }).tags, ['ManualHistory']);
  assert.deepEqual(pool.get({ ...scope, pixivUserId: '' }, { jobs }).tags, [], 'empty bindings cannot establish historical ownership');
  await pool.edit(scope, { addTags: ['ManualName'], jobs });
  const queries = ['原神', 'おへそ', 'ManualName', 'ManualHistory'].map(word => ({ word }));
  assert.deepEqual(pool.evidence(scope, queries, { jobs }).matches, []);
  await pool.sync(scope, remote());
  const evidence = pool.evidence(scope, queries, { jobs });
  assert.deepEqual(evidence.matches.map(item => item.tag), ['原神', 'おへそ']);
  assert.ok(evidence.matches.every(item => item.cached && item.verified && item.source === 'pixiv-cache' && item.checkedAt === checkedAt));
  assert.ok(evidence.preferredTags.includes('ManualName'));
  assert.ok(evidence.preferredTags.includes('ManualHistory'));
  assert.equal(evidence.matches.find(item => item.tag === 'おへそ').url, 'https://www.pixiv.net/artworks/42');
});

test('invalid input and failed remote responses preserve pool; partially unavailable history retains original evidence date', async t => {
  const { pool } = await fixture(t);
  await pool.sync(scope, remote());
  const prior = pool.get(scope);
  for (const addTags of [['has space'], ['line\nbreak'], ['x'.repeat(65)], [''], Array(201).fill('a')]) {
    assert.throws(() => pool.edit(scope, { addTags }), /标签/);
  }
  await assert.rejects(pool.sync(scope, remote({ pixivUserId: '987' })), /不一致/);
  await assert.rejects(pool.sync(scope, remote({ checkedAt: 'invalid' })), /响应无效/);
  assert.deepEqual(pool.get(scope), prior);
  await pool.sync(scope, remote({ checkedAt: '2026-10-14T01:00:00.000Z', frequentTags: ['原神'], recentWorks: [], historyWarning: 'unavailable' }));
  const evidence = pool.evidence(scope, [{ word: 'おへそ' }]);
  assert.equal(evidence.checkedAt, '2026-10-14T01:00:00.000Z');
  assert.equal(evidence.matches[0].checkedAt, checkedAt);
  assert.ok(pool.get(scope).tags.includes('おへそ'));
});

test('manual additions are bounded atomically, and concurrent edits survive restart', async t => {
  const { dataDir, pool } = await fixture(t);
  await Promise.all(['a', 'b', 'c'].map(value => pool.edit(scope, { addTags: [value] })));
  assert.deepEqual((await createTagPools({ dataDir })).get(scope).tags, ['a', 'b', 'c']);
  await pool.edit(scope, { addTags: Array.from({ length: 197 }, (_, index) => `tag${index}`) });
  await assert.rejects(pool.edit(scope, { addTags: ['overflow'] }), /最多 200/);
  assert.equal(pool.get(scope).tags.length, 200);
  assert.ok(!pool.get(scope).tags.includes('overflow'));
  const newPool = await createTagPools({ dataDir });
  assert.equal(newPool.get(scope).tags.length, 200);
});

test('history accumulates across syncs, refreshes an existing artwork, and keeps exact tag spelling and order', async t => {
  const { pool, dataDir } = await fixture(t);
  const tags = ['ＧｅｎｓｈｉｎＩｍｐａｃｔ', 'GenshinImpact', '原神', '原神', 'モナ(原神)', '女の子'];
  await pool.sync(scope, remote({ recentWorks: [{ artworkId: '42', title: 'Mona', tags }, { artworkId: '41', title: 'Earlier', tags: ['黒タイツ'] }] }));
  const nextTime = '2026-10-14T01:00:00.000Z';
  await pool.sync(scope, remote({ checkedAt: nextTime, recentWorks: [{ artworkId: '43', title: 'New', tags: ['新規'] }] }));
  let evidence = pool.evidence(scope, [{ word: '黒タイツ' }]);
  assert.deepEqual(evidence.recentWorks.map(work => work.artworkId), ['43', '42', '41']);
  assert.deepEqual(evidence.recentWorks[1].tags, [tags[0], tags[1], '原神', 'モナ(原神)', '女の子']);
  assert.equal(evidence.matches[0].checkedAt, checkedAt, 'old tags must not be described as freshly checked');
  await pool.sync(scope, remote({ checkedAt: nextTime, recentWorks: [{ artworkId: '42', title: 'Corrected', tags: ['原神', 'モナ(原神)', '水着'] }], historyWarning: 'partial' }));
  evidence = pool.evidence(scope);
  assert.deepEqual(evidence.recentWorks.map(work => work.artworkId), ['43', '42', '41']);
  assert.equal(evidence.recentWorks[1].title, 'Corrected');
  assert.deepEqual(evidence.recentWorks[1].tags, ['原神', 'モナ(原神)', '水着']);
  assert.equal(evidence.recentWorks[1].checkedAt, nextTime);
  const reloaded = await createTagPools({ dataDir });
  assert.deepEqual(reloaded.evidence(scope).recentWorks, evidence.recentWorks);
  assert.deepEqual(reloaded.evidence({ ...scope, accountId: 'other' }).recentWorks, []);
  assert.deepEqual(reloaded.evidence({ ...scope, pixivUserId: '456' }).recentWorks, []);
  assert.deepEqual(reloaded.evidence({ ...scope, mode: 'demo' }).recentWorks, []);
});

test('expanded remote history retains 5000 newest works even when older pages arrive later', async t => {
  const { pool } = await fixture(t);
  await pool.sync(scope, remote({ recentWorks: Array.from({ length: 5000 }, (_, i) => ({ artworkId: String(5001 - i), title: 'Old', tags: ['原神'] })) }));
  await pool.sync(scope, remote({ recentWorks: [{ artworkId: '1', title: 'Oldest', tags: ['原神'] }, { artworkId: '5002', title: 'Newest', tags: ['原神'] }] }));
  const history = pool.evidence(scope).recentWorks;
  assert.equal(history.length, 5000);
  assert.equal(history[0].artworkId, '5002');
  assert.equal(history.at(-1).artworkId, '3');
});

test('deep history progress survives restart and a later partial scan never erases old works', async t => {
  const { pool, dataDir } = await fixture(t);
  const historyScan = { total: 100, offset: 0, nextOffset: 20, attempted: 20, succeeded: 19, failed: 1,
    remaining: 80, truncated: true, complete: false, failedArtworkIds: ['42'] };
  await pool.sync(scope, remote({ historyScan, historyWarning: '部分读取完成' }));
  const reloaded = await createTagPools({ dataDir });
  assert.equal(reloaded.get(scope).historyScan.nextOffset, 20);
  assert.equal(reloaded.get(scope).historyScan.complete, false);
  assert.equal(reloaded.get(scope).historyCount, 1);
  await reloaded.sync(scope, remote({ recentWorks: [], historyScan: { ...historyScan, offset: 20, nextOffset: 100, succeeded: 80, failed: 0, remaining: 0, truncated: false, complete: true } }));
  assert.equal(reloaded.get(scope).historyCount, 1);
  assert.equal(reloaded.get(scope).historyScan.rangeComplete, true);
  assert.equal(reloaded.get(scope).historyScan.complete, false);
  assert.equal(reloaded.get(scope).historyScan.failed, 1);
  assert.deepEqual(reloaded.get(scope).historyScan.failedArtworkIds, ['42']);
  assert.match(reloaded.get(scope).historyWarning, /仍有 1 件/);
  await reloaded.sync(scope, remote({ recentWorks: [], historyScan: { total: null, attempted: 0, succeeded: 0, failed: 0, nextOffset: 0, complete: false, truncated: true, stoppedReason: 'index_unavailable' } }));
  assert.equal(reloaded.get(scope).historyCount, 1);
  assert.equal(reloaded.get(scope).historyScan.total, null);
  assert.equal(reloaded.get(scope).historyScan.stoppedReason, 'index_unavailable');
  assert.equal(reloaded.get(scope).historyScan.complete, false);
});

test('history diagnostics retain only safe error fields across restart', async t => {
  const { pool, dataDir } = await fixture(t);
  await pool.sync(scope, remote({ recentWorks: [], historyScan: { total: null, offset: 0, nextOffset: 0, failed: 0,
    complete: false, stoppedReason: 'rate_limited',
    lastError: { phase: 'index', code: 'http_error', httpStatus: 429, retryAfterSeconds: 120, body: 'PRIVATE RESPONSE', cookie: 'SECRET' },
    errorCounts: { 'http_error:429': 1, invalid_json: 2, 'PRIVATE RESPONSE': 9, timeout: -1 } } }));
  const reloaded = await createTagPools({ dataDir });
  const scan = reloaded.get(scope).historyScan;
  assert.deepEqual(scan.lastError, { phase: 'index', code: 'http_error', httpStatus: 429, retryAfterSeconds: 120 });
  assert.deepEqual(scan.errorCounts, { 'http_error:429': 1, invalid_json: 2 });
  assert.doesNotMatch(JSON.stringify(scan), /PRIVATE|SECRET/);
});

test('continuous history pages retain earlier failures until a successful read and only a complete fresh run clears the warning', async t => {
  const { pool } = await fixture(t);
  const work = artworkId => ({ artworkId, title: 'Robin', tags: ['HonkaiStarRail', 'ロビン(スターレイル)'] });
  await pool.sync(scope, remote({ recentWorks: [work('3')], historyScan: { total: 3, offset: 0, nextOffset: 2, attempted: 2,
    succeeded: 1, failed: 1, failedArtworkIds: ['2'], remaining: 1, complete: false, truncated: true } }));
  await pool.sync(scope, remote({ recentWorks: [work('1')], historyScan: { total: 3, offset: 2, nextOffset: 3, attempted: 1,
    succeeded: 1, failed: 0, failedArtworkIds: [], remaining: 0, complete: true, truncated: false } }));
  let status = pool.get(scope);
  assert.equal(status.historyScan.coveredFromStart, true);
  assert.equal(status.historyScan.rangeComplete, true);
  assert.equal(status.historyScan.complete, false);
  assert.equal(status.historyScan.failed, 1);
  assert.deepEqual(status.historyScan.failedArtworkIds, ['2']);
  assert.deepEqual(pool.evidence(scope).recentWorks.map(work => work.artworkId), ['3', '1']);
  await pool.sync(scope, remote({ recentWorks: [work('2')], historyScan: { total: 3, offset: 1, nextOffset: 2, attempted: 1,
    succeeded: 1, failed: 0, failedArtworkIds: [], remaining: 1, complete: false, truncated: true } }));
  status = pool.get(scope);
  assert.equal(status.historyScan.failed, 0);
  assert.equal(status.historyScan.complete, false);
  assert.equal(status.historyScan.coveredFromStart, false);
  assert.deepEqual(pool.evidence(scope).recentWorks.map(work => work.artworkId), ['3', '2', '1']);
  await pool.sync(scope, remote({ recentWorks: ['3', '2', '1'].map(work), historyScan: { total: 3, offset: 0, nextOffset: 3, attempted: 3,
    succeeded: 3, failed: 0, failedArtworkIds: [], remaining: 0, complete: true, truncated: false } }));
  assert.equal(pool.get(scope).historyScan.complete, true);
  assert.equal(pool.get(scope).historyWarning, null);
});

test('middle-only and changed-size history scans never claim complete coverage while all verified rows remain usable', async t => {
  const { pool } = await fixture(t);
  const scan = (offset, nextOffset, total = 3) => ({ total, offset, nextOffset, attempted: nextOffset - offset,
    succeeded: nextOffset - offset, failed: 0, failedArtworkIds: [], remaining: total - nextOffset,
    complete: nextOffset === total, truncated: nextOffset !== total });
  await pool.sync(scope, remote({ recentWorks: [{ artworkId: '2', tags: ['原神'] }], historyScan: scan(1, 2) }));
  await pool.sync(scope, remote({ recentWorks: [{ artworkId: '1', tags: ['原神'] }], historyScan: scan(2, 3) }));
  assert.equal(pool.get(scope).historyScan.rangeComplete, true);
  assert.equal(pool.get(scope).historyScan.complete, false);
  assert.equal(pool.get(scope).historyScan.coveredFromStart, false);
  await pool.sync(scope, remote({ recentWorks: [{ artworkId: '3', tags: ['原神'] }], historyScan: scan(0, 1) }));
  await pool.sync(scope, remote({ recentWorks: [{ artworkId: '4', tags: ['原神'] }], historyScan: scan(1, 4, 4) }));
  assert.equal(pool.get(scope).historyScan.rangeComplete, true);
  assert.equal(pool.get(scope).historyScan.complete, false);
  assert.equal(pool.get(scope).historyScan.coveredFromStart, false);
  assert.equal(pool.get(scope).historyCount, 4);
  await pool.sync(scope, remote({ recentWorks: [], historyScan: scan(0, 1, 4) }));
  await pool.sync(scope, remote({ recentWorks: [], historyScan: scan(1, 4, 4) }));
  assert.equal(pool.get(scope).historyScan.coveredFromStart, true);
  assert.equal(pool.get(scope).historyScan.complete, true);
});

test('a complete remote read above local storage capacity is explicitly marked as incomplete retention', async t => {
  const { pool } = await fixture(t);
  await pool.sync(scope, remote({ historyScan: { total: 5001, offset: 0, nextOffset: 5001, attempted: 5001, succeeded: 5001,
    failed: 0, failedArtworkIds: [], remaining: 0, complete: true, truncated: false } }));
  assert.equal(pool.get(scope).historyScan.rangeComplete, true);
  assert.equal(pool.get(scope).historyScan.storageTruncated, true);
  assert.equal(pool.get(scope).historyScan.complete, false);
  assert.match(pool.get(scope).historyWarning, /5000 件保存上限/);
});

test('template evidence learns only confirmed published jobs with matching ownership and keeps remote truth on duplicate IDs', async t => {
  const { pool } = await fixture(t);
  await pool.sync(scope, remote());
  const published = { id: 'base', accountId: scope.accountId, pixivUserId: scope.pixivUserId, status: 'published', tagsConfirmed: true, title: 'Robin', tags: ['Ｈｏｎｋａｉ', 'Honkai', '女の子'], publishedAt: checkedAt };
  const jobs = [
    { ...published, id: 'fresh', artworkId: '43' },
    { ...published, id: 'fallback' },
    { ...published, id: 'known', artworkId: '42', title: 'Stale local title', tags: ['StaleLocalTag'] },
    ...['draft', 'reserved', 'queued', 'failed', 'cancelled', 'needs_review'].map(status => ({ ...published, id: status, status })),
    { ...published, id: 'unconfirmed', tagsConfirmed: false },
    { ...published, id: 'other-account', accountId: 'other' },
    { ...published, id: 'other-owner', pixivUserId: '456' },
    { ...published, id: 'unbound', pixivUserId: undefined },
  ];
  const evidence = pool.evidence(scope, [{ word: 'Honkai' }], { jobs });
  assert.deepEqual(evidence.recentWorks.map(work => work.artworkId), ['43', 'local:fallback', '42']);
  assert.deepEqual(evidence.recentWorks[0].tags, published.tags);
  assert.equal(evidence.recentWorks[0].source, 'local-published');
  assert.equal(evidence.recentWorks[1].source, 'local-published');
  assert.equal(evidence.recentWorks[1].url, undefined);
  assert.equal(evidence.recentWorks[2].title, 'Mona');
  assert.equal(evidence.recentWorks[2].source, 'pixiv-history');
  assert.deepEqual(evidence.matches, [], 'local history does not claim a current Pixiv lookup');
  assert.deepEqual(pool.evidence({ ...scope, pixivUserId: '' }, [], { jobs }).recentWorks, []);
});
