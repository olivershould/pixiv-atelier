import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readArtworkAnalytics, readAnalyticsOverview, readAnalyticsWorksPage } from '../server/browser-analytics.mjs';
import { createBrowserConnector } from '../server/browser-connector.mjs';
import { normalizeArtworkThumbnail } from '../server/artwork-thumbnail.mjs';

const plain = value => JSON.parse(JSON.stringify(value));
const goodWork = (id, overrides = {}) => ({ id, userId: '101', title: `Work ${id}`, tags: { tags: [{ tag: 'Game' }, { tag: 'Character' }] },
  createDate: '2026-01-01T09:00:00+09:00', viewCount: 120, bookmarkCount: 12, likeCount: 8, ...overrides });
function fixture({ identity = '101', works = {}, failures = {}, before = async () => {}, profile = { illusts: {}, manga: {} }, reportLinks = {},
  followers = { error: false, body: { users: [], total: 120 } },
  management = { data: { works: [], fetchRanges: [] }, thumbnails: { illust: [] } }, pageManagement = management } = {}) {
  const requests = [], props = { isLoggedIn: true, serverSerializedPreloadedState: JSON.stringify({ userData: { self: { id: identity } } }) };
  const context = vm.createContext({ location: { origin: 'https://www.pixiv.net' }, URL, AbortController, setTimeout, clearTimeout,
    DOMParser: class { parseFromString(text) { return text === '<report>' ? { querySelectorAll: selector => reportLinks[selector] || [] }
      : { getElementById: () => ({ textContent: JSON.stringify({ props: { pageProps: props } }) }) }; } },
    fetch: async (url, options) => {
      requests.push({ url, options }); await before(url);
      if (failures[url]) return failures[url];
      if (url === '/dashboard/works') return { ok: true, text: async () => '<fixture>' };
      if (url === '/dashboard/report/artworks?graph_term=month') return { ok: true, text: async () => '<report>' };
      if (url === '/ajax/user/101/followers?offset=0&limit=24&lang=zh') return { ok: true, text: async () => JSON.stringify(followers) };
      if (url.startsWith('/ajax/dashboard/works/illust')) return { ok: true, text: async () => JSON.stringify({ body: url.includes('request_strategy') ? management : pageManagement }) };
      if (url.startsWith('/ajax/user/')) return { ok: true, text: async () => JSON.stringify({ body: profile }) };
      const id = url.split('/').at(-1);
      return { ok: true, text: async () => JSON.stringify({ body: works[id] || goodWork(id) }) };
    } });
  return { requests, run: args => vm.runInContext(`(${readArtworkAnalytics.toString()})(${JSON.stringify({ expectedId: '101', artworkIds: ['300'], ...args })})`, context),
    overview: args => vm.runInContext(`(${readAnalyticsOverview.toString()})(${JSON.stringify({ expectedId: '101', ...args })})`, context),
    bulk: args => vm.runInContext(`(${readAnalyticsWorksPage.toString()})(${JSON.stringify({ expectedId: '101', ...args })})`, context) };
}

test('analytics details retain real metrics, exact tags and publication date with per-work observation times', async () => {
  const f = fixture({ works: { 300: goodWork('300', { tags: { tags: [{ tag: 'Game' }, { tag: 'R-18' }, { tag: 'Character' }] } }) } });
  const result = plain(await f.run({ artworkIds: ['300', '300', '299'] }));
  assert.equal(result.complete, true);
  assert.deepEqual(result.artworks.map(work => work.artworkId), ['300', '299']);
  assert.deepEqual(result.artworks[0].tags, ['Game', 'R-18', 'Character']);
  assert.equal(result.artworks[0].createDate, '2026-01-01T00:00:00.000Z');
  assert.equal(result.artworks[0].viewCount, 120);
  assert.equal(result.artworks[0].bookmarkCount, 12);
  assert.equal(result.artworks[0].likeCount, 8);
  assert.ok(Number.isFinite(Date.parse(result.artworks[0].observedAt)));
  assert.deepEqual(f.requests.map(item => item.url), ['/dashboard/works', '/ajax/illust/300', '/ajax/illust/299']);
  assert.ok(f.requests.every(item => item.options.credentials === 'same-origin' && item.options.cache === 'no-store' && item.options.redirect === 'error'));
});

test('serialized artwork and bulk readers export only same-artwork bounded thumbnails without falling back to originals', async () => {
  const safe = 'https://i.pximg.net/c/250x250_80_a2/img-master/img/2026/01/02/03/04/05/300_p0_square1200.jpg';
  const custom = safe.replace('250x250_80_a2', '360x360_70').replace('img-master', 'custom-thumb').replace('square1200', 'custom1200');
  const original = 'https://i.pximg.net/img-original/img/2026/01/02/03/04/05/300_p0.png';
  for (const value of [safe, custom, original, null, {}, undefined, safe.replace('300_p0', '299_p0'), safe.replace('250x250', '400x400'),
    safe.replace('i.pximg.net', 'i.pximg.net.attacker.test'), `${safe}?secret=token`, safe.replace('/img/2026', '/img/%2e%2e/2026')]) {
    const expected = normalizeArtworkThumbnail(value, '300');
    const detail = plain(await fixture({ works: { 300: goodWork('300', { urls: { thumb: value, original, small: safe } }) } }).run());
    assert.equal(detail.artworks[0].thumbnailUrl, expected, String(value));
    assert.equal(detail.complete, true);
    assert.doesNotMatch(JSON.stringify(detail), /img-original|secret=token/);
    const management = managementBody(['300']);
    management.thumbnails.illust[0].url = value;
    management.thumbnails.illust[0].original = original;
    const bulk = plain(await fixture({ management }).bulk());
    assert.equal(bulk.artworks[0].thumbnailUrl, expected, String(value));
    assert.equal(bulk.complete, true);
    assert.doesNotMatch(JSON.stringify(bulk), /img-original|secret=token/);
  }
});

const reportLink = (section, value, id = '101', extra = {}) => ({ getAttribute: () => `/dashboard/report/artworks?section=${section}&user_id=${id}&graph_term=month`,
  querySelectorAll: selector => selector === ':scope > div.count' ? [{ textContent: value }] : [], ...extra });

test('account summary uses followers-page total independently of the report follower counter', async () => {
  const f = fixture({ reportLinks: { 'a.report-link.section-access': [reportLink('access', '12,345')],
    'a.report-link.section-follow': [reportLink('follower', '999,999')] }, followers: { error: false, body: { total: 321, users: [{ name: 'PRIVATE FOLLOWER NAME', id: '777' }] } } });
  const result = plain(await f.overview({ includeAccount: true }));
  assert.equal(result.complete, true);
  assert.equal(result.account.viewCount, 12345);
  assert.equal(result.account.followerCount, 321);
  assert.equal(result.account.source.viewCount.section, 'access');
  assert.deepEqual(result.account.source.followerCount, { seriesId: 'pixiv-followers-page-total-v1', url: 'https://www.pixiv.net/users/101/followers',
    endpoint: 'https://www.pixiv.net/ajax/user/101/followers?offset=0&limit=24&lang=zh', field: 'body.total', scope: 'current', surface: 'followers-page' });
  assert.deepEqual(f.requests.map(item => item.url), ['/dashboard/works', '/dashboard/report/artworks?graph_term=month', '/ajax/user/101/followers?offset=0&limit=24&lang=zh']);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE FOLLOWER|777/);
  assert.ok(f.requests.every(item => item.options.credentials === 'same-origin' && item.options.cache === 'no-store' && item.options.redirect === 'error'));
  const zero = plain(await fixture({ reportLinks: { 'a.report-link.section-access': [reportLink('access', '0')],
    'a.report-link.section-follow': [reportLink('follower', '999')] }, followers: { body: { users: [], total: 0 } } }).overview({ includeAccount: true }));
  assert.equal(zero.account.viewCount, 0);
  assert.equal(zero.account.followerCount, 0);
});

test('account counters reject another owner, ambiguous nodes, abbreviations and malformed comma grouping', async () => {
  for (const [name, links] of [
    ['owner', [reportLink('access', '100', '202')]],
    ['duplicate', [reportLink('access', '100'), reportLink('access', '200')]],
    ['abbreviated', [reportLink('access', '1.2万')]],
    ['grouping', [reportLink('access', '12,34')]],
    ['overflow', [reportLink('access', '9007199254740992')]],
    ['nested', [reportLink('access', '100', '101', { querySelectorAll: () => [] })]],
  ]) {
    const result = plain(await fixture({ reportLinks: { 'a.report-link.section-access': links,
      'a.report-link.section-follow': [reportLink('follower', '120')] } }).overview({ includeAccount: true }));
    assert.equal(result.account.viewCount, null, name);
    assert.equal(result.account.followerCount, 120, name);
    assert.equal(result.complete, false, name);
    assert.ok(result.errors.some(error => error.metric === 'viewCount'), name);
  }
});

test('invalid, missing and remote-error follower totals stay null while preserving valid views', async () => {
  for (const [name, followers, code] of [
    ['null total', { body: { total: null } }, 'schema_changed'],
    ['string total', { body: { total: '123' } }, 'schema_changed'],
    ['negative total', { body: { total: -1 } }, 'schema_changed'],
    ['fraction total', { body: { total: 1.5 } }, 'schema_changed'],
    ['overflow total', { body: { total: 9007199254740992 } }, 'schema_changed'],
    ['missing total', { body: { users: [] } }, 'metric_missing'],
    ['missing body', {}, 'metric_missing'],
    ['invalid JSON shape', null, 'schema_changed'],
    ['remote error', { error: true, body: { total: 500 }, message: 'PRIVATE REMOTE ERROR' }, 'remote_error'],
  ]) {
    const result = plain(await fixture({ followers, reportLinks: { 'a.report-link.section-access': [reportLink('access', '123')],
      'a.report-link.section-follow': [reportLink('follower', '999')] } }).overview({ includeAccount: true }));
    assert.equal(result.account.followerCount, null, name);
    assert.equal(result.account.viewCount, 123, name);
    assert.equal(result.account.source.followerCount, undefined, name);
    assert.equal(result.complete, false, name);
    assert.ok(result.errors.some(error => error.metric === 'followerCount' && error.code === code), name);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE REMOTE ERROR/);
  }
});

test('report failures preserve follower counts, but report rate limiting stops the next request', async () => {
  const unavailable = fixture({ failures: { '/dashboard/report/artworks?graph_term=month': { ok: false, status: 503 } }, followers: { body: { total: 42 } } });
  const result = plain(await unavailable.overview({ includeAccount: true }));
  assert.equal(result.account.viewCount, null);
  assert.equal(result.account.followerCount, 42);
  assert.equal(result.errors[0].metric, 'viewCount');
  assert.equal(unavailable.requests.length, 3);
  const limited = fixture({ failures: { '/dashboard/report/artworks?graph_term=month': { ok: false, status: 429, headers: { get: () => '240' } } } });
  const paused = plain(await limited.overview({ includeAccount: true }));
  assert.equal(paused.account.viewCount, null);
  assert.equal(paused.account.followerCount, null);
  assert.equal(paused.errors[0].httpStatus, 429);
  assert.equal(paused.errors[0].retryAfterSeconds, 240);
  assert.deepEqual(limited.requests.map(item => item.url), ['/dashboard/works', '/dashboard/report/artworks?graph_term=month']);
});

test('followers-page rate limiting preserves views and reports its own retry delay', async () => {
  const f = fixture({ reportLinks: { 'a.report-link.section-access': [reportLink('access', '123')] },
    failures: { '/ajax/user/101/followers?offset=0&limit=24&lang=zh': { ok: false, status: 429, headers: { get: () => '300' } } } });
  const result = plain(await f.overview({ includeAccount: true }));
  assert.equal(result.account.viewCount, 123);
  assert.equal(result.account.followerCount, null);
  assert.ok(result.errors.some(error => error.metric === 'followerCount' && error.httpStatus === 429 && error.retryAfterSeconds === 300));
});

test('fresh identity mismatch prevents account report and followers requests', async () => {
  const f = fixture({ identity: '202' });
  const result = plain(await f.overview({ includeAccount: true }));
  assert.equal(result.account, null);
  assert.equal(result.errors[0].code, 'identity_mismatch');
  assert.deepEqual(f.requests.map(item => item.url), ['/dashboard/works']);
});

test('unknown, invalid and absent metrics remain null instead of silently becoming zero', async () => {
  const f = fixture({ works: { 300: goodWork('300', { viewCount: undefined, bookmarkCount: '12', likeCount: -1 }), 299: goodWork('299', { viewCount: 0, bookmarkCount: 0, likeCount: 0 }) } });
  const { artworks } = plain(await f.run({ artworkIds: ['300', '299'] }));
  assert.deepEqual([artworks[0].viewCount, artworks[0].bookmarkCount, artworks[0].likeCount], [null, null, null]);
  assert.deepEqual([artworks[1].viewCount, artworks[1].bookmarkCount, artworks[1].likeCount], [0, 0, 0]);
});

test('fresh account mismatch prevents detail calls, without returning private page contents', async () => {
  const f = fixture({ identity: '202' });
  const result = plain(await f.run());
  assert.equal(result.complete, false);
  assert.equal(result.errors[0].code, 'identity_mismatch');
  assert.deepEqual(result.artworks, []);
  assert.deepEqual(f.requests.map(item => item.url), ['/dashboard/works']);
});

test('foreign, mismatched, reserved and invalid-date works are excluded independently', async () => {
  const f = fixture({ works: { 300: goodWork('300', { userId: '202', title: 'PRIVATE TITLE' }), 299: goodWork('999'),
    298: goodWork('298', { isReserved: true }), 297: goodWork('297', { createDate: 'missing' }) } });
  const result = plain(await f.run({ artworkIds: ['300', '299', '298', '297', '296'] }));
  assert.deepEqual(result.artworks.map(work => work.artworkId), ['296']);
  assert.deepEqual(result.failedArtworkIds, ['300', '299', '298', '297']);
  assert.deepEqual(result.errors.map(error => error.code), ['owner_mismatch', 'artwork_mismatch', 'not_published', 'schema_changed']);
  assert.equal(result.complete, false);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
});

test('rate limiting stops new work, retains completed records and reports server retry delay', async () => {
  const f = fixture({ failures: { '/ajax/illust/300': { ok: false, status: 429, headers: { get: () => '120' } } },
    before: async url => { if (url === '/ajax/illust/299') await new Promise(resolve => setTimeout(resolve, 15)); } });
  const result = plain(await f.run({ artworkIds: ['300', '299', '298', '297'] }));
  assert.equal(result.rateLimited, true);
  assert.equal(result.retryAfterSeconds, 120);
  assert.deepEqual(result.attemptedArtworkIds, ['300', '299']);
  assert.deepEqual(result.remainingArtworkIds, ['298', '297']);
  assert.deepEqual(result.artworks.map(work => work.artworkId), ['299']);
});

test('invalid or oversized detail batches are rejected before network access', async () => {
  const f = fixture();
  await assert.rejects(f.run({ artworkIds: ['../bad'] }), /批次/);
  await assert.rejects(f.run({ artworkIds: Array.from({ length: 11 }, (_, index) => String(index)) }), /批次/);
  assert.deepEqual(f.requests, []);
});

test('complete analytics index uses the account-owned illustration and manga index without detail requests', async () => {
  const f = fixture({ profile: { illusts: { 9: null, 101: null }, manga: { 12: null, 101: null } } });
  const result = plain(await f.overview({ includeIndex: true }));
  assert.equal(result.complete, true);
  assert.deepEqual(result.index.artworkIds, ['101', '12', '9']);
  assert.equal(result.index.total, 3);
  assert.equal(result.account, null);
  assert.deepEqual(f.requests.map(item => item.url), ['/dashboard/works', '/ajax/user/101/profile/all?lang=zh']);
  const unknown = plain(await fixture({ profile: {} }).overview({ includeIndex: true }));
  assert.equal(unknown.index, null);
  assert.equal(unknown.errors[0].code, 'schema_changed');
});

async function connectorFixture(t, handler) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pixiv-analytics-'));
  t.after(async () => { assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir())); await fs.rm(dataDir, { recursive: true, force: true }); });
  const targetId = 'A'.repeat(32), calls = [], selected = [];
  const driver = { tabs: async () => [{ targetId, url: 'https://www.pixiv.net/' }], select: async id => selected.push(id),
    evaluate: async (fn, args) => { calls.push({ fn, args }); return handler(fn, args); },
    command: async () => assert.fail('Analytics must not activate windows or submit forms') };
  return { calls, selected, connector: await createBrowserConnector({ dataDir, driver }), account: { id: 'local', pixivUserId: '101', browser: { targetId } } };
}

test('connector selects only the bound tab and independently requests index and deadline detail data', async t => {
  const f = await connectorFixture(t, async (fn, args) => {
    if (fn === readAnalyticsOverview) return plain(await fixture().overview(args));
    assert.equal(fn, readArtworkAnalytics); return plain(await fixture().run(args));
  });
  const index = await f.connector.analytics(f.account, { includeIndex: true });
  assert.equal(index.index.total, 0);
  assert.equal(index.account, null);
  assert.equal(f.calls.length, 1);
  const detail = await f.connector.analytics(f.account, { artworkIds: ['300'] });
  assert.equal(detail.artworks[0].artworkId, '300');
  assert.deepEqual(detail.remainingArtworkIds, []);
  assert.deepEqual(f.selected, ['A'.repeat(32), 'A'.repeat(32)]);
  assert.equal(f.calls.length, 2);
});

test('connector honors 429 cooldown across calls and refuses stale account data', async t => {
  const f = await connectorFixture(t, () => ({ pixivUserId: '101', artworks: [], complete: false, attemptedArtworkIds: ['300'], failedArtworkIds: ['300'], remainingArtworkIds: [],
    errors: [{ phase: 'detail', code: 'http_error', httpStatus: 429, retryAfterSeconds: 180 }], rateLimited: true }));
  const first = await f.connector.analytics(f.account, { artworkIds: ['300'] });
  assert.equal(first.retryAfterSeconds, 180);
  const second = await f.connector.analytics(f.account, { artworkIds: ['301'] });
  assert.equal(second.rateLimited, true);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(second.remainingArtworkIds, ['301']);
  const mismatch = await connectorFixture(t, () => ({ pixivUserId: '202', artworks: [], errors: [], complete: true }));
  await assert.rejects(mismatch.connector.analytics(mismatch.account, { artworkIds: ['300'] }), /账号/);
});

const managementRow = (id, extra = {}) => ({ workId: id, workType: 'illust', viewCount: 698, ratingCount: 137, bookmarkCount: 187, createDate: '2026-01-01 09:00:22', ...extra });
const thumbnail = (id, extra = {}) => ({ id, title: `Work ${id}`, userId: '101', tags: ['Game', 'Character'], createDate: '2026-01-01T09:00:22+09:00', ...extra });
const managementBody = (ids, ranges = []) => ({ data: { works: ids.map(id => managementRow(id)), fetchRanges: ranges }, thumbnails: { illust: ids.map(id => thumbnail(id)) } });

test('management bulk page maps verified counters and owner metadata without artwork detail requests', async () => {
  const f = fixture({ management: managementBody(['300', '299'], [[2, 1000], [1002, 12]]) });
  const result = plain(await f.bulk());
  assert.equal(result.complete, true);
  assert.equal(result.total, 1014);
  assert.deepEqual(result.nextRange, { offset: 2, limit: 1000 });
  assert.deepEqual(result.fetchRanges, [[2, 1000], [1002, 12]]);
  assert.equal(result.artworks[0].likeCount, 137);
  assert.equal(result.artworks[0].bookmarkCount, 187);
  assert.equal(result.artworks[0].viewCount, 698);
  assert.equal(result.artworks[0].createDate, '2026-01-01T00:00:22.000Z');
  assert.equal(result.artworks[0].publicationTimeVerified, false);
  assert.equal(result.artworks[0].createDateSource, 'pixiv-management-thumbnail');
  assert.deepEqual(f.requests.map(item => item.url), ['/dashboard/works', '/ajax/dashboard/works/illust/request_strategy?lang=zh']);
});

test('verified bulk pagination reads one requested range and never infers a total from a short page', async () => {
  const f = fixture({ pageManagement: managementBody(['298', '297']) });
  const result = plain(await f.bulk({ offset: 200, limit: 101 }));
  assert.equal(result.complete, true);
  assert.equal(result.total, null);
  assert.equal(result.fetchRanges, null);
  assert.deepEqual(result.page, { offset: 200, limit: 101, count: 2 });
  assert.equal(f.requests[1].url, '/ajax/dashboard/works/illust?offset=200&limit=101&lang=zh');
  await assert.rejects(f.bulk({ offset: -1 }), /分页/);
  await assert.rejects(f.bulk({ offset: 200, limit: 1001 }), /分页/);
});

test('bulk ignores reserved collections and rejects foreign, future, draft and ambiguous metadata', async () => {
  const management = managementBody(['300', '299', '298', '297', '296', '295']);
  management.data.reservedWorks = [managementRow('999')];
  management.data.drafts = [managementRow('998')];
  management.thumbnails.illust[0].userId = '202';
  management.thumbnails.illust[1].createDate = '2999-01-01T09:00:00+09:00';
  management.thumbnails.illust[2].isDraft = true;
  management.thumbnails.illust[3].isReserved = true;
  management.thumbnails.illust.push(thumbnail('296'));
  const result = plain(await fixture({ management }).bulk());
  assert.equal(result.complete, false);
  assert.deepEqual(result.artworks.map(work => work.artworkId), ['295']);
  assert.deepEqual(result.failedArtworkIds, ['300', '299', '298', '297', '296']);
  assert.deepEqual(result.attemptedArtworkIds, ['300', '299', '298', '297', '296', '295']);
});

test('owner-private and friends-only published works retain statistics and visibility metadata', async () => {
  const management = managementBody(['300', '299']);
  Object.assign(management.thumbnails.illust[0], { restrict: 2, visibilityScope: 4, isUnlisted: false, isMasked: false });
  management.thumbnails.illust[1].restrict = 1;
  const result = plain(await fixture({ management }).bulk());
  assert.equal(result.complete, true);
  assert.deepEqual(result.artworks.map(work => work.artworkId), ['300', '299']);
  assert.equal(result.artworks[0].viewCount, 698);
  assert.deepEqual(result.artworks[0].visibility, { restrict: 2, visibilityScope: 4, isUnlisted: false, isMasked: false });
  assert.equal(result.artworks[1].visibility.restrict, 1);
});

test('bulk rejects non-contiguous pagination and duplicate work IDs rather than claiming complete coverage', async () => {
  const gap = plain(await fixture({ management: managementBody(['300'], [[2, 1000]]) }).bulk());
  assert.equal(gap.complete, false);
  assert.equal(gap.errors[0].code, 'schema_changed');
  assert.deepEqual(gap.artworks, []);
  const duplicate = plain(await fixture({ management: managementBody(['300', '300']) }).bulk());
  assert.equal(duplicate.complete, false);
  assert.deepEqual(duplicate.artworks, []);
});

test('connector exposes bulk ranges and flags disagreement with the complete profile index', async t => {
  const browser = fixture({ management: managementBody(['300'], [[1, 2]]), profile: { illusts: { 300: null, 299: null }, manga: {} } });
  const f = await connectorFixture(t, async (fn, args) => {
    if (fn === readAnalyticsOverview) return plain(await browser.overview(args));
    assert.equal(fn, readAnalyticsWorksPage); return plain(await browser.bulk(args));
  });
  const result = await f.connector.analytics(f.account, { bulk: true, includeIndex: true });
  assert.equal(result.capabilities.bulkWorks, true);
  assert.equal(result.complete, false);
  assert.ok(result.errors.some(error => error.code === 'index_mismatch'));
  assert.equal(result.total, 3);
  assert.deepEqual(result.nextRange, { offset: 1, limit: 2 });
  assert.equal(result.artworks.length, 1);
  await assert.rejects(f.connector.analytics(f.account, { bulk: true, artworkIds: ['300'] }), /不能同时/);
});
