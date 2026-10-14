import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readTags, readPublishedHistory } from '../server/browser-driver.mjs';
import { createBrowserConnector } from '../server/browser-connector.mjs';

const accountId = '101';
const plain = value => JSON.parse(JSON.stringify(value));
const response = body => ({ ok: true, json: async () => body, text: async () => JSON.stringify(body) });
function pageFixture({ identity = accountId, frequentTags = [], works = [], details = {}, responses = {}, search = [], profile = { illusts: {}, manga: {} }, dashboardFails = false, beforeResponse = async () => {} } = {}) {
  const requests = [];
  const pageProps = { isLoggedIn: true, serverSerializedPreloadedState: JSON.stringify({ userData: { self: { id: identity } } }) };
  const context = vm.createContext({
    location: { origin: 'https://www.pixiv.net' },
    AbortController, setTimeout, clearTimeout,
    DOMParser: class {
      parseFromString() {
        return {
          getElementById: () => ({ textContent: JSON.stringify({ props: { pageProps } }) }),
          querySelectorAll: () => frequentTags.map(tag => ({ textContent: `# ${tag}` })),
        };
      }
    },
    fetch: async (url, options) => {
      requests.push({ url, options });
      await beforeResponse(url);
      if (Object.hasOwn(responses, url)) return responses[url];
      if (url === '/illustration/create') return { ok: true, text: async () => '<fixture>' };
      if (url.startsWith('/ajax/tags/')) return response({ body: { candidates: search } });
      if (url.startsWith('/ajax/user/')) return response({ body: profile });
      if (url.startsWith('/ajax/dashboard/')) {
        if (dashboardFails) throw new Error('Sensitive upstream body is never returned');
        return response({ body: { data: { works } } });
      }
      if (url.startsWith('/ajax/illust/')) {
        const id = url.split('/').at(-1);
        const body = Object.hasOwn(details, id) ? details[id] : { id, userId: accountId, title: `Work ${id}`, tags: { tags: [{ tag: '原神' }, { tag: 'R-18' }, { tag: 'モナ(原神)' }, { tag: 'おへそ' }] } };
        if (body instanceof Error) throw body;
        return response({ body });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });
  const run = args => vm.runInContext(`(${readTags.toString()})(${JSON.stringify({ expectedId: accountId, words: ['原神'], ...args })})`, context);
  const runHistory = args => vm.runInContext(`(${readPublishedHistory.toString()})(${JSON.stringify({ expectedId: accountId, ...args })})`, context);
  return { requests, run, runHistory };
}

test('fresh Pixiv identity mismatch stops tag search and published history reads', async () => {
  const f = pageFixture({ identity: '202' });
  await assert.rejects(f.run({ includeHistory: true }), /登录账号发生变化/);
  assert.deepEqual(f.requests.map(r => r.url), ['/illustration/create']);
});

test('recent work tags preserve posting order, read at most six unique valid IDs, and match only relevant queries', async () => {
  const f = pageFixture({ works: ['300', 'bad', '300', '299', '298', '297', '296', '295', '294'].map(workId => ({ workId })) });
  const result = plain(await f.run({ includeHistory: true, words: ['原神', 'モナ(原神)'] }));
  assert.deepEqual(result.recentWorks.map(w => w.artworkId), ['300', '299', '298', '297', '296', '295']);
  assert.deepEqual(result.recentWorks[0].tags, ['原神', 'R-18', 'モナ(原神)', 'おへそ']);
  assert.deepEqual(result.matches.map(m => m.tag), ['原神', 'モナ(原神)']);
  assert.equal(result.matches[0].url, 'https://www.pixiv.net/artworks/300');
  assert.equal(result.historyWarning, undefined);
  assert.equal(f.requests.filter(r => r.url.startsWith('/ajax/illust/')).length, 6);
  assert.ok(f.requests.every(r => r.options.credentials === 'same-origin' && r.options.redirect === 'error'));
  assert.ok(f.requests.filter(r => !r.url.startsWith('/ajax/tags/')).every(r => r.options.cache === 'no-store'));
});

test('foreign-owned and mismatched artwork details never leave Chrome while verified work and search survive', async () => {
  const f = pageFixture({ works: [{ workId: '300' }, { workId: '299' }, { workId: '298' }],
    search: [{ tag_name: '原神', total_count: 10 }],
    details: {
      '300': { id: '300', userId: '202', title: 'FOREIGN PRIVATE TITLE', tags: { tags: [{ tag: 'FOREIGN PRIVATE TAG' }] } },
      '299': { id: '999', userId: accountId, title: 'WRONG ARTWORK', tags: { tags: [{ tag: 'UNVERIFIED TAG' }] } },
    } });
  const result = plain(await f.run({ includeHistory: true }));
  assert.deepEqual(result.recentWorks.map(w => w.artworkId), ['298']);
  assert.deepEqual(result.matches.map(m => m.tag), ['原神']);
  assert.match(result.historyWarning, /部分/);
  assert.doesNotMatch(JSON.stringify(result), /FOREIGN|WRONG ARTWORK|UNVERIFIED/);
});

test('explicit history sync reads up to 60 works and preserves distinct original aliases', async () => {
  const tags = ['Ｈｏｎｋａｉ', 'Honkai', '崩壊:スターレイル', 'Ｈｏｎｋａｉ'];
  const f = pageFixture({ works: Array.from({ length: 70 }, (_, i) => ({ workId: String(400 - i) })),
    details: { '400': { id: '400', userId: accountId, title: 'Robin', tags: { tags: tags.map(tag => ({ tag })) } } } });
  const result = plain(await f.run({ includeHistory: true, historyLimit: 500, words: [] }));
  assert.equal(result.recentWorks.length, 60);
  assert.equal(f.requests.filter(request => request.url.startsWith('/ajax/illust/')).length, 60);
  assert.deepEqual(result.recentWorks[0].tags, tags.slice(0, 3));
  assert.equal(result.recentWorks.at(-1).artworkId, '341');
});

test('history endpoint failure is optional and does not discard whole-site or frequent tag matches', async () => {
  const f = pageFixture({ dashboardFails: true, frequentTags: ['おへそ'], search: [{ tag_name: '原神', total_count: 20 }] });
  const result = plain(await f.run({ includeHistory: true, words: ['おへそ'] }));
  assert.deepEqual(result.recentWorks, []);
  assert.deepEqual(result.matches.map(m => m.tag), ['原神', 'おへそ']);
  assert.match(result.historyWarning, /暂时无法读取/);
  assert.doesNotMatch(JSON.stringify(result), /Sensitive/);
});

test('ordinary keyword search makes no dashboard or artwork requests', async () => {
  const f = pageFixture({ works: [{ workId: '300' }], search: [{ tag_name: '原神' }] });
  const result = plain(await f.run({}));
  assert.equal(result.recentWorks, undefined);
  assert.equal(result.matches.length, 1);
  assert.equal(f.requests.length, 2);
});

test('recognized favorite and history tags beyond network query budget remain matchable without additional searches', async () => {
  const words = [...Array.from({ length: 32 }, (_, i) => `network${i}`), 'おへそ', 'モナ(原神)', 'unmatched'];
  const f = pageFixture({ frequentTags: ['おへそ', '無関係'], works: [{ workId: '300' }] });
  const result = plain(await f.run({ includeHistory: true, words }));
  assert.equal(f.requests.filter(request => request.url.startsWith('/ajax/tags/')).length, 32);
  assert.deepEqual(result.matches.map(match => match.tag), ['おへそ', 'モナ(原神)']);
  assert.equal(result.matches[0].url, 'https://www.pixiv.net/illustration/create');
  assert.equal(result.matches[1].url, 'https://www.pixiv.net/artworks/300');
  assert.equal(result.matches.some(match => ['無関係', 'unmatched', 'R-18'].includes(match.tag)), false);
});

test('bounded parallel read-only requests preserve query and artwork order despite out-of-order responses', async () => {
  const active = { search: 0, detail: 0 }, peak = { search: 0, detail: 0 }, completed = [];
  const words = Array.from({ length: 9 }, (_, i) => `word${i}`);
  const ids = ['300', '299', '298', '297', '296', '295'];
  const f = pageFixture({ works: ids.map(workId => ({ workId })), search: [{ tag_name: '匹配' }],
    beforeResponse: async url => {
      const kind = url.startsWith('/ajax/tags/') ? 'search' : url.startsWith('/ajax/illust/') ? 'detail' : null;
      if (!kind) return;
      active[kind]++; peak[kind] = Math.max(peak[kind], active[kind]);
      await new Promise(resolve => setTimeout(resolve, /word0|\/300$/.test(url) ? 20 : 1));
      active[kind]--; completed.push(url);
    } });
  const result = plain(await f.run({ includeHistory: true, words }));
  assert.equal(peak.search, 4);
  assert.equal(peak.detail, 3);
  assert.deepEqual(result.matches.map(m => m.word), words);
  assert.deepEqual(result.recentWorks.map(w => w.artworkId), ids);
  assert.ok(completed.indexOf('/ajax/illust/299') < completed.indexOf('/ajax/illust/300'));
});

test('connector opts into history only explicitly and selects the bound tab without window commands', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'huaxu-tag-history-'));
  t.after(async () => { assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir())); await fs.rm(dataDir, { recursive: true, force: true }); });
  const targetId = 'A'.repeat(32), selected = [], evaluated = [];
  const driver = {
    tabs: async () => [{ targetId, url: 'https://www.pixiv.net/' }],
    select: async target => selected.push(target),
    evaluate: async (fn, args) => { assert.equal(fn, readTags); evaluated.push(args); return {}; },
    command: async () => assert.fail('Tag history must not issue window commands'),
  };
  const connector = await createBrowserConnector({ dataDir, driver });
  const account = { pixivUserId: accountId, browser: { targetId } };
  await connector.searchTags(account, ['原神', '原神']);
  await connector.searchTags(account, Array.from({ length: 300 }, (_, i) => String(i)), { includeHistory: true });
  await connector.searchTags(account, [], { includeHistory: true, historyLimit: 60 });
  assert.deepEqual(selected, [targetId, targetId, targetId]);
  assert.deepEqual(evaluated[0], { expectedId: accountId, words: ['原神'], includeHistory: false });
  assert.equal(evaluated[1].includeHistory, true);
  assert.equal(evaluated[1].words.length, 256);
  assert.equal(evaluated[1].historyLimit, undefined);
  assert.equal(evaluated[2].historyLimit, 60);
});

test('complete history index includes illustration and manga IDs in stable newest-first order with resumable offsets', async () => {
  const f = pageFixture({ profile: { illusts: { 7: null, 101: null, 8: null }, manga: { 12: null, 101: null, 9: null } } });
  const result = plain(await f.runHistory({ historyOffset: 1, historyLimit: 3 }));
  assert.deepEqual(result.artworkIds, ['12', '9', '8']);
  assert.equal(result.total, 5);
  assert.equal(result.offset, 1);
  assert.equal(result.pixivUserId, accountId);
  assert.deepEqual(f.requests.map(request => request.url), ['/illustration/create', '/ajax/user/101/profile/all?lang=zh']);
  assert.ok(f.requests.every(request => request.options.credentials === 'same-origin' && request.options.redirect === 'error' && request.options.cache === 'no-store'));
});

test('full history refuses changed login and unknown index schemas without reading artwork or exposing details', async () => {
  const mismatch = pageFixture({ identity: '202' });
  await assert.rejects(mismatch.runHistory({ artworkIds: ['300'] }), /登录账号发生变化/);
  assert.equal(mismatch.requests.length, 1);
  assert.deepEqual(plain((await pageFixture({ profile: { unexpected: [] } }).runHistory({})).historyError), { phase: 'index', code: 'schema_changed' });
  const empty = plain(await pageFixture({ profile: { illusts: [], manga: [] } }).runHistory({}));
  assert.equal(empty.total, 0);
  const nullable = plain(await pageFixture({ profile: { illusts: { 300: null }, manga: null } }).runHistory({}));
  assert.deepEqual(nullable.artworkIds, ['300']);
  assert.equal(nullable.total, 1);
  assert.equal((await pageFixture({ profile: { illusts: { bad: null }, manga: null } }).runHistory({})).historyError.code, 'schema_changed');
});

test('full history detail batches preserve exact tag order and exclude foreign, reserved, draft and mismatched works', async () => {
  const tags = ['Ｈｏｎｋａｉ', 'Honkai', 'R-18', 'ルアン・メェイ', 'Ｈｏｎｋａｉ'];
  const work = (id, extra) => ({ id, userId: accountId, title: 'RuanMei', tags: { tags: tags.map(tag => ({ tag })) }, ...extra });
  const f = pageFixture({ details: {
    '300': work('300'), '299': work('299', { userId: '202', title: 'FOREIGN TITLE' }),
    '298': work('298', { isReserved: true }), '297': work('297', { status: 'draft' }),
    '296': work('999'), '295': new Error('PRIVATE ERROR CONTENT'),
  } });
  const result = plain(await f.runHistory({ artworkIds: ['300', '299', '298', '297', '296', '295'] }));
  assert.deepEqual(result.recentWorks, [{ artworkId: '300', title: 'RuanMei', tags: tags.slice(0, 4) }]);
  assert.deepEqual(result.failedArtworkIds, ['299', '298', '297', '296', '295']);
  assert.deepEqual(result.attemptedArtworkIds, ['300', '299', '298', '297', '296', '295']);
  assert.deepEqual(result.remainingArtworkIds, []);
  assert.doesNotMatch(JSON.stringify(result), /FOREIGN|PRIVATE/);
  assert.equal(f.requests[0].url, '/illustration/create');
  await assert.rejects(f.runHistory({ artworkIds: Array.from({ length: 11 }, (_, i) => String(i + 1)) }), /批次无效/);
});

test('full history detail requests have bounded concurrency and stop starting requests after rate limiting', async () => {
  let active = 0, peak = 0;
  const f = pageFixture({ responses: { '/ajax/illust/300': { ok: false, status: 429, headers: { get: () => '300' } } }, beforeResponse: async url => {
    if (!url.startsWith('/ajax/illust/')) return;
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, url.endsWith('/300') ? 1 : 5));
    active--;
  } });
  const ids = ['300', '299', '298', '297', '296', '295'];
  const result = plain(await f.runHistory({ artworkIds: ids }));
  assert.equal(peak, 3);
  assert.equal(result.rateLimited, true);
  assert.deepEqual(result.attemptedArtworkIds, ids.slice(0, 3));
  assert.deepEqual(result.remainingArtworkIds, ids.slice(3));
  assert.deepEqual(result.recentWorks.map(work => work.artworkId), ['299', '298']);
});

async function completeHistoryConnector(t, { total = 45, detailFailure = false, indexFailure = false, indexError, detailErrors, historyBatchDelayMs = 0 } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'huaxu-full-history-'));
  t.after(async () => { assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir())); await fs.rm(dataDir, { recursive: true, force: true }); });
  const targetId = 'B'.repeat(32), calls = [], selected = [];
  const ids = Array.from({ length: total }, (_, i) => String(1000 - i));
  const driver = {
    tabs: async () => [{ targetId, url: 'https://www.pixiv.net/' }], select: async value => selected.push(value),
    command: async () => assert.fail('History reads never activate a browser window'),
    evaluate: async (fn, args) => {
      calls.push({ fn, args, at: Date.now() });
      if (fn === readTags) return { pixivUserId: args.expectedId, frequentTags: ['原神'], matches: [], checkedAt: '2026-10-13T01:00:00Z' };
      assert.equal(fn, readPublishedHistory);
      if (!args.artworkIds) {
        if (indexFailure) throw new Error('PRIVATE INDEX ERROR');
        if (indexError) return { pixivUserId: args.expectedId, historyError: indexError };
        return { pixivUserId: args.expectedId, total, artworkIds: ids.slice(args.historyOffset, args.historyOffset + args.historyLimit) };
      }
      if (detailFailure && args.artworkIds[0] === ids[20]) throw new Error('PRIVATE BATCH ERROR');
      const failedIds = (detailErrors || []).map(error => error.artworkId).filter(id => args.artworkIds.includes(id));
      return { pixivUserId: args.expectedId, recentWorks: args.artworkIds.filter(id => !failedIds.includes(id)).map(artworkId => ({ artworkId, title: 'RuanMei', tags: ['原神', 'ルアン・メェイ'] })),
        attemptedArtworkIds: args.artworkIds, failedArtworkIds: failedIds, remainingArtworkIds: [], historyErrors: detailErrors || [] };
    },
  };
  const connector = await createBrowserConnector({ dataDir, driver, historyBatchDelayMs });
  const account = { pixivUserId: accountId, browser: { targetId } };
  return { connector, account, calls, selected, ids, targetId };
}

test('full history connector reads all batches through the same background tab and preserves keyword matches', async t => {
  const f = await completeHistoryConnector(t);
  const result = await f.connector.searchTags(f.account, ['原神'], { includeHistory: true, fullHistory: true });
  assert.deepEqual(f.selected, [f.targetId]);
  assert.equal(f.calls[0].args.includeHistory, false);
  assert.deepEqual(f.calls.slice(2).map(call => call.args.artworkIds.length), [10, 10, 10, 10, 5]);
  assert.deepEqual(result.recentWorks.map(work => work.artworkId), f.ids);
  assert.deepEqual(result.matches.map(match => match.tag), ['原神']);
  assert.equal(result.historyScan.total, 45);
  assert.equal(result.historyScan.attempted, 45);
  assert.equal(result.historyScan.succeeded, 45);
  assert.equal(result.historyScan.failed, 0);
  assert.equal(result.historyScan.nextOffset, 45);
  assert.equal(result.historyScan.completed, true);
  assert.equal(result.historyScan.truncated, false);
  assert.equal(result.historyWarning, undefined);
});

test('full history limits report remaining work and next offset resumes without replaying prior IDs', async t => {
  const f = await completeHistoryConnector(t);
  const first = await f.connector.searchTags(f.account, [], { includeHistory: true, fullHistory: true, historyLimit: 25 });
  assert.equal(first.historyScan.total, 45);
  assert.equal(first.historyScan.nextOffset, 25);
  assert.equal(first.historyScan.remaining, 20);
  assert.equal(first.historyScan.completed, false);
  assert.equal(first.historyScan.truncated, true);
  assert.equal(first.historyScan.stoppedReason, 'work_limit');
  const next = await f.connector.searchTags(f.account, [], { includeHistory: true, fullHistory: true, historyOffset: first.historyScan.nextOffset });
  assert.deepEqual(next.recentWorks.map(work => work.artworkId), f.ids.slice(25));
  assert.equal(next.historyScan.offset, 25);
  assert.equal(next.historyScan.nextOffset, 45);
  assert.equal(next.historyScan.completed, true);
});

test('full history partial and index failures remain explicit and retain successful batches', async t => {
  const f = await completeHistoryConnector(t, { detailFailure: true });
  const partial = await f.connector.searchTags(f.account, [], { includeHistory: true, fullHistory: true });
  assert.equal(partial.recentWorks.length, 20);
  assert.equal(partial.historyScan.attempted, 30);
  assert.equal(partial.historyScan.failed, 10);
  assert.equal(partial.historyScan.nextOffset, 30);
  assert.equal(partial.historyScan.remaining, 15);
  assert.equal(partial.historyScan.completed, false);
  assert.match(partial.historyWarning, /10 件读取失败/);
  assert.doesNotMatch(JSON.stringify(partial), /PRIVATE/);
  const g = await completeHistoryConnector(t, { indexFailure: true });
  const failed = await g.connector.searchTags(g.account, [], { includeHistory: true, fullHistory: true });
  assert.equal(failed.historyScan.total, null);
  assert.equal(failed.historyScan.attempted, 0);
  assert.equal(failed.historyScan.completed, false);
  assert.equal(failed.historyScan.truncated, true);
  assert.deepEqual(failed.frequentTags, ['原神']);
  assert.match(failed.historyWarning, /暂时无法核对完整/);
  assert.doesNotMatch(JSON.stringify(failed), /PRIVATE/);
});

test('history reads return safe HTTP, timeout, JSON and schema diagnostics without upstream bodies', async () => {
  const indexUrl = '/ajax/user/101/profile/all?lang=zh';
  for (const status of [403, 429, 503]) {
    const f = pageFixture({ responses: { [indexUrl]: { ok: false, status, headers: { get: () => '120' }, text: async () => 'PRIVATE UPSTREAM BODY' } } });
    const result = plain(await f.runHistory({}));
    assert.deepEqual(result.historyError, { phase: 'index', code: 'http_error', httpStatus: status, retryAfterSeconds: 120 });
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  }
  const malformed = pageFixture({ responses: { [indexUrl]: { ok: true, text: async () => '<PRIVATE INVALID JSON>' } } });
  assert.deepEqual(plain((await malformed.runHistory({})).historyError), { phase: 'index', code: 'invalid_json' });
  const timedOut = pageFixture({ beforeResponse: async url => { if (url === indexUrl) throw Object.assign(new Error('PRIVATE TIMEOUT'), { name: 'AbortError' }); } });
  assert.deepEqual(plain((await timedOut.runHistory({})).historyError), { phase: 'index', code: 'timeout' });
  const network = pageFixture({ beforeResponse: async url => { if (url === indexUrl) throw new Error('PRIVATE NETWORK ERROR'); } });
  assert.deepEqual(plain((await network.runHistory({})).historyError), { phase: 'index', code: 'network_error' });
  const identity = pageFixture({ responses: { '/illustration/create': { ok: false, status: 403 } } });
  assert.deepEqual(plain((await identity.runHistory({ artworkIds: ['300'] })).historyError), { phase: 'identity', code: 'http_error', httpStatus: 403 });
  assert.equal(identity.requests.length, 1);
});

test('full history reports safe failure reasons while keeping successful artwork and distinguishing index rate limits', async t => {
  const limited = await completeHistoryConnector(t, { indexError: { phase: 'index', code: 'http_error', httpStatus: 429,
    retryAfterSeconds: 120, body: 'PRIVATE BODY', message: 'PRIVATE MESSAGE' } });
  const indexResult = await limited.connector.searchTags(limited.account, [], { includeHistory: true, fullHistory: true });
  assert.equal(indexResult.historyScan.stoppedReason, 'rate_limited');
  assert.deepEqual(indexResult.historyScan.lastError, { phase: 'index', code: 'http_error', httpStatus: 429, retryAfterSeconds: 120 });
  assert.deepEqual(indexResult.historyScan.errorCounts, { 'http_error:429': 1 });
  assert.match(indexResult.historyWarning, /HTTP 429/);
  assert.match(indexResult.historyWarning, /120 秒/);
  assert.doesNotMatch(JSON.stringify(indexResult), /PRIVATE/);
  const requestsBeforeRetry = limited.calls.length;
  await assert.rejects(limited.connector.searchTags({ ...limited.account, pixivUserId: '202' }, [],
    { includeHistory: true, fullHistory: true, historyTimeBudgetMs: 1000 }), /等待读取间隔/);
  assert.equal(limited.calls.length, requestsBeforeRetry, 'Retry-After blocks new requests across accounts');
  const f = await completeHistoryConnector(t, { total: 3, detailErrors: [
    { phase: 'detail', code: 'http_error', httpStatus: 404, artworkId: '1000', body: 'PRIVATE DETAIL' },
    { phase: 'detail', code: 'invalid_json', artworkId: '999', text: 'PRIVATE JSON' },
  ] });
  const partial = await f.connector.searchTags(f.account, [], { includeHistory: true, fullHistory: true });
  assert.deepEqual(partial.recentWorks.map(work => work.artworkId), ['998']);
  assert.equal(partial.historyScan.failed, 2);
  assert.equal(partial.historyScan.complete, false);
  assert.deepEqual(partial.historyScan.errorCounts, { 'http_error:404': 1, invalid_json: 1 });
  assert.match(partial.historyWarning, /有效 JSON/);
  assert.doesNotMatch(JSON.stringify(partial), /PRIVATE/);
});

test('full history pacing is shared across batches and account scans while tests can use an internal shorter interval', async t => {
  const f = await completeHistoryConnector(t, { total: 11, historyBatchDelayMs: 25 });
  await f.connector.searchTags(f.account, [], { includeHistory: true, fullHistory: true });
  const first = [...f.calls];
  assert.deepEqual(first.filter(call => call.args.artworkIds).map(call => call.args.artworkIds.length), [10, 1]);
  assert.ok(first[2].at - first[1].at >= 20, 'first details wait after index');
  assert.ok(first[3].at - first[2].at >= 20, 'later batch waits after prior details');
  await f.connector.searchTags({ ...f.account, pixivUserId: '202' }, [], { includeHistory: true, fullHistory: true });
  assert.ok(f.calls[4].at - first.at(-1).at >= 20, 'new account shares the prior account pacing');
});
