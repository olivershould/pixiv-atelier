import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server/index.mjs';
import { createDemoState, blankState } from '../server/seed.mjs';
import { createTagPools } from '../server/tag-pool.mjs';

const evidence = JSON.parse(await fs.readFile(new URL('./fixtures/posting-history.json', import.meta.url), 'utf8'));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=', 'base64');
PNG.writeUInt32BE(4020414299, 52);
async function fixture(t, title = '', { score = .96, localOnly = false, supplemental = false } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'posting-template-api-'));
  const live = blankState(), pools = await createTagPools({ dataDir });
  live.accounts = evidence.liveAccounts.map((record, index) => ({ id: `history-${index}`, name: record.account,
    pixivUserId: record.pixivUserId, premium: true, timezone: 'Asia/Tokyo', browser: { targetId: `fixture-${index}`, postingEnabled: false }, remote: { reservations: [], total: 0 } }));
  for (const [index, record] of evidence.liveAccounts.entries()) {
    const scope = { mode: 'live', accountId: live.accounts[index].id, pixivUserId: record.pixivUserId };
    if (localOnly) live.jobs.push(...record.history.map(work => ({ id: `local-${work.artworkId}`, accountId: scope.accountId,
      pixivUserId: scope.pixivUserId, artworkId: work.artworkId, title: work.title, tags: work.tags, tagsConfirmed: true,
      status: 'published', publishedAt: evidence.checkedAt, files: [], content: {} })));
    else await pools.sync(scope, { pixivUserId: record.pixivUserId, checkedAt: evidence.checkedAt,
      frequentTags: [...record.history.flatMap(work => work.tags), ...(supplemental ? ['RuanMei', ...(index === 1 ? ['火花(スターレイル)', '花火(スターレイル)'] : [])] : [])], recentWorks: record.history });
  }
  if (supplemental) await fs.writeFile(path.join(dataDir, 'character-memory.json'), JSON.stringify({ version: 1, modes: { demo: [], live: [{
    id: '11111111-2222-4333-8444-555555555555', englishName: 'RuanMei', gameTags: ['HonkaiStarRail', '崩坏星穹铁道'],
    characterTags: ['RuanMei'], updatedAt: evidence.checkedAt,
    samples: [{ fileId: 'test-reference', sha256: 'a'.repeat(64), addedAt: evidence.checkedAt }],
  }] } }));
  await fs.writeFile(path.join(dataDir, 'state.json'), JSON.stringify({ version: 1, mode: 'live', states: { live, demo: createDemoState() }, uploads: {} }));
  let browserCalls = 0;
  const server = await createServer({ dataDir, background: false,
    browserConnector: { close: async () => {}, searchTags: async () => { browserCalls++; throw new Error('ordinary template use must stay local'); } },
    tagger: { status: async () => ({ configured: true, ready: true }), close: async () => {},
      analyze: async files => ({ source: 'local', candidates: [], predictions: [{ name: 'navel', category: 0, score, fileId: files[0].id }],
        analyzedFiles: await Promise.all(files.map(async file => ({ id: file.id, sha256: createHash('sha256').update(await fs.readFile(file.path)).digest('hex') }))),
        recognition: { title, rating: 'r18', sexualContent: null, characters: title ? [{ englishName: title }] : [],
          perFile: files.map(file => ({ fileId: file.id, single: true, multiple: false })) } }) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir())); await fs.rm(dataDir, { recursive: true, force: true }); });
  const request = async (route, payload, method = payload === undefined ? 'GET' : 'POST') => { const response = await fetch(base + route, { method,
    headers: { 'Content-Type': 'application/json' }, body: payload === undefined ? undefined : JSON.stringify(payload) }); return { status: response.status, data: await response.json() }; };
  const catalog = account => request(`/api/characters/templates?mode=live&accountId=${account.id}`);
  const analyze = async account => {
    const response = await fetch(base + '/api/files?name=template-test.png', { method: 'POST', body: PNG });
    const { file } = await response.json();
    const draft = { accountId: account.id, title: '', files: [file], tags: [], tagsConfirmed: false, content: { aiGenerated: true, rating: null } };
    return { ...await request('/api/tags/suggest', { provider: 'local', draft }), draft };
  };
  return { request, catalog, analyze, accounts: live.accounts, browserCalls: () => browserCalls };
}

test('history selector exposes account-specific complete tag spellings including three game tags without Chrome', async t => {
  const f = await fixture(t), [alpha, beta] = f.accounts;
  const first = await f.catalog(alpha), second = await f.catalog(beta);
  assert.equal(first.status, 200); assert.equal(first.data.historyCount, 6); assert.equal(first.data.templates.filter(item => item.source === 'pixiv-history').length, 5);
  assert.equal(second.data.templates.filter(item => item.source === 'pixiv-history').length, 6);
  const h = first.data.templates.find(item => item.englishName === 'Robin'), n = second.data.templates.find(item => item.englishName === 'Robin');
  assert.deepEqual(h.gameTags, ['崩壊スターレイル', 'HonkaiStarRail']);
  assert.deepEqual(n.gameTags, ['HonkaiStarRail', '崩坏星穹铁道']); assert.notEqual(h.id, n.id);
  assert.deepEqual(second.data.templates.find(item => item.englishName === 'Sunna').gameTags, ['绝区零', 'ゼンレスゾーンゼロ', 'ZenlessZoneZero']);
  assert.equal(f.browserCalls(), 0); assert.deepEqual((await f.request('/api/characters')).data.characters, []);
});

test('single selection reproduces the account sequence while current rating and conditions control variable tags', async t => {
  const f = await fixture(t), [account] = f.accounts;
  const template = (await f.catalog(account)).data.templates.find(item => item.englishName === 'Robin');
  const input = { mode: 'live', accountId: account.id, templateId: template.id, name: template.englishName };
  const result = await f.request('/api/characters/resolve', { ...input, rating: 'r18', sceneTags: ['おへそ'] });
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.orderedTags, evidence.liveAccounts[0].history[0].tags);
  const plain = await f.request('/api/characters/resolve', { ...input, rating: 'all' });
  assert.ok(!plain.data.orderedTags.includes('R-18')); assert.ok(!plain.data.orderedTags.includes('おへそ'));
  assert.ok(plain.data.optionalTags.includes('おへそ'));
  assert.deepEqual((await f.request('/api/state')).data.jobs, []); assert.equal(f.browserCalls(), 0);
});

test('manual selection uses server-cached current image conditions and rejects another account analysis/template', async t => {
  const f = await fixture(t), [alpha, beta] = f.accounts;
  const template = (await f.catalog(alpha)).data.templates.find(item => item.englishName === 'Robin');
  const analysis = await f.analyze(alpha); assert.equal(analysis.status, 200); assert.ok(analysis.data.memoryAnalysisId);
  const input = { mode: 'live', accountId: alpha.id, templateId: template.id, name: 'Robin', rating: 'r18', analysisId: analysis.data.memoryAnalysisId };
  const resolved = await f.request('/api/characters/resolve', input);
  assert.equal(resolved.status, 200); assert.deepEqual(resolved.data.orderedTags, evidence.liveAccounts[0].history[0].tags);
  assert.equal((await f.request('/api/characters/resolve', { ...input, accountId: beta.id })).status, 409);
  const betaTemplate = (await f.catalog(beta)).data.templates.find(item => item.englishName === 'Robin');
  assert.equal((await f.request('/api/characters/resolve', { ...input, accountId: beta.id, templateId: betaTemplate.id })).status, 409);
  assert.equal((await f.request('/api/characters/resolve', { ...input, mode: 'demo' })).status, 409);
  assert.equal((await f.request('/api/characters/resolve', { ...input, name: 'Mona' })).status, 409);
  assert.equal(f.browserCalls(), 0);
});

test('automatic recognition and one-click choice return identical template order without a live browser request', async t => {
  const f = await fixture(t, 'Robin'), [account] = f.accounts;
  const result = await f.analyze(account); assert.equal(result.status, 200);
  const response = result.data; assert.equal(response.accountId, account.id); assert.equal(response.pixivUserId, account.pixivUserId);
  assert.deepEqual(response.automaticTags, evidence.liveAccounts[0].history[0].tags);
  const manual = await f.request('/api/characters/resolve', { mode: 'live', accountId: account.id, templateId: response.template.id,
    name: 'Robin', rating: 'r18', analysisId: response.memoryAnalysisId });
  assert.deepEqual(manual.data.orderedTags, response.orderedTags); assert.equal(f.browserCalls(), 0);
});

test('mode round trips and account rebinding invalidate prior image evidence even when the original account returns', async t => {
  const f = await fixture(t), [account] = f.accounts;
  const template = (await f.catalog(account)).data.templates.find(item => item.englishName === 'Robin');
  const analyzed = await f.analyze(account);
  const input = { mode: 'live', accountId: account.id, templateId: template.id, name: 'Robin', rating: 'r18', analysisId: analyzed.data.memoryAnalysisId };
  await f.request('/api/mode', { mode: 'demo' }); await f.request('/api/mode', { mode: 'live' });
  assert.equal((await f.request('/api/characters/resolve', input)).status, 409);
  const next = await f.analyze(account); input.analysisId = next.data.memoryAnalysisId;
  await f.request(`/api/accounts/${account.id}`, { pixivUserId: '555555' }, 'PATCH');
  await f.request(`/api/accounts/${account.id}`, { pixivUserId: account.pixivUserId }, 'PATCH');
  assert.equal((await f.request('/api/characters/resolve', input)).status, 409);
});

test('local confirmed published history works without remote cache dates or a Chrome connection', async t => {
  const f = await fixture(t, 'Robin', { localOnly: true }), [account] = f.accounts;
  const catalog = (await f.catalog(account)).data; assert.equal(catalog.historyCount, 6); assert.equal(catalog.checkedAt, null);
  const result = await f.analyze(account); assert.equal(result.status, 200);
  assert.deepEqual(result.data.orderedTags, evidence.liveAccounts[0].history[0].tags);
  assert.equal(result.data.tagSearch.source, 'local-history');
  assert.ok(result.data.template.sources.every(source => source.source === 'local-published'));
  assert.equal(f.browserCalls(), 0);
});

test('intermediate scene confidence stays optional identically for automatic and manually selected templates', async t => {
  const f = await fixture(t, 'Robin', { score: .75 }), [account] = f.accounts;
  const response = (await f.analyze(account)).data;
  assert.ok(!response.orderedTags.includes('おへそ')); assert.ok(response.optionalTags.includes('おへそ'));
  const manual = await f.request('/api/characters/resolve', { mode: 'live', accountId: account.id, templateId: response.template.id,
    name: 'Robin', rating: 'r18', analysisId: response.memoryAnalysisId });
  assert.deepEqual(manual.data.orderedTags, response.orderedTags);
  assert.equal(f.browserCalls(), 0);
});

test('drafts retain template tag ownership for later edits and reject metadata from another account', async t => {
  const f = await fixture(t, 'Robin'), [account, other] = f.accounts;
  const analysis = await f.analyze(account), template = analysis.data.template, tags = analysis.data.orderedTags;
  const metadata = { id: template.id, accountId: account.id, pixivUserId: account.pixivUserId, englishName: 'Robin',
    gameTags: template.gameTags, characterTags: template.characterTags, ownedTags: tags, removedTags: [] };
  const input = { ...analysis.draft, title: 'Robin', tags: [...tags, '自定义'], status: 'draft', tagTemplate: metadata };
  const saved = await f.request('/api/jobs', input); assert.equal(saved.status, 200, JSON.stringify(saved.data));
  const job = saved.data.jobs.find(item => item.id === saved.data.createdJobId);
  assert.deepEqual(job.tagTemplate.ownedTags, tags); assert.ok(!job.tagTemplate.ownedTags.includes('自定义'));
  assert.deepEqual((await f.request('/api/state')).data.jobs[0].tagTemplate, job.tagTemplate);
  assert.equal((await f.request('/api/jobs', { ...input, tagTemplate: { ...metadata, accountId: other.id } })).status, 409);
  const cleared = await f.request(`/api/jobs/${job.id}`, { tagTemplate: null }, 'PATCH');
  assert.equal(cleared.status, 200); assert.equal(cleared.data.jobs[0].tagTemplate, undefined);
});

test('remembered and verified common characters enter both selectors using each account own game format', async t => {
  const f = await fixture(t, '', { supplemental: true }), [alpha, beta] = f.accounts;
  for (const account of [alpha, beta]) {
    const catalog = (await f.catalog(account)).data;
    const ruan = catalog.templates.find(item => item.englishName === 'RuanMei');
    const sparxie = catalog.templates.find(item => item.englishName === 'Sparxie');
    assert.ok(ruan); assert.ok(sparxie);
    for (const [template, name, roleTag] of [[ruan, 'Ruan Mei', 'RuanMei'], [sparxie, 'Sparxie', '火花(スターレイル)']]) {
      assert.equal(template.source, 'account-style'); assert.equal(template.sampleCount, 0);
      assert.deepEqual(template.sourceArtworkIds, []); assert.ok(template.formatSourceArtworkIds.length);
      const response = await f.request('/api/characters/resolve', { mode: 'live', accountId: account.id, name,
        templateId: template.id, rating: 'r18' });
      assert.equal(response.status, 200, JSON.stringify(response.data));
      assert.equal(response.data.source, 'account-style-template');
      assert.deepEqual(response.data.characterTags, [roleTag]);
      assert.deepEqual(response.data.gameTags, account === alpha ? ['崩壊スターレイル', 'HonkaiStarRail'] : ['HonkaiStarRail', '崩坏星穹铁道']);
      assert.ok(!response.data.tags.includes('ロビン(スターレイル)'));
      assert.ok(!response.data.tags.includes('花火(スターレイル)'));
      assert.ok(!response.data.tags.includes('おへそ'), 'donor work conditions must not become character defaults');
      assert.equal(response.data.tags.indexOf('R-18'), account === alpha ? 0 : 2);
      if (account === alpha) {
        const currentScene = await f.request('/api/characters/resolve', { mode: 'live', accountId: account.id, name,
          templateId: template.id, rating: 'r18', sceneTags: ['おへそ'] });
        assert.ok(currentScene.data.tags.includes('おへそ'), 'current image evidence can still supply a familiar scene tag');
      }
    }
    const chinese = await f.request('/api/characters/resolve', { mode: 'live', accountId: account.id, name: '阮梅', rating: 'all' });
    assert.equal(chinese.data.status, 'resolved'); assert.deepEqual(chinese.data.characterTags, ['RuanMei']);
    const sparkle = await f.request('/api/characters/resolve', { mode: 'live', accountId: account.id, name: 'Sparkle', rating: 'all' });
    assert.deepEqual(sparkle.data.characterTags, ['花火(スターレイル)']);
  }
  assert.equal(f.browserCalls(), 0); assert.deepEqual((await f.request('/api/state')).data.jobs, []);
  assert.equal((await f.request('/api/characters')).data.characters.length, 1, 'catalog does not create visual memories');
});

test('remembered recognition and explicit selection share supplemental account formatting', async t => {
  const f = await fixture(t, 'RuanMei', { supplemental: true }), [account] = f.accounts;
  const response = (await f.analyze(account)).data;
  assert.equal(response.template.source, 'account-style');
  const manual = await f.request('/api/characters/resolve', { mode: 'live', accountId: account.id, name: 'RuanMei',
    templateId: response.template.id, rating: 'r18', analysisId: response.memoryAnalysisId });
  assert.deepEqual(manual.data.orderedTags, response.orderedTags);
  assert.deepEqual(response.template.gameTags, ['崩壊スターレイル', 'HonkaiStarRail']);
  assert.equal(f.browserCalls(), 0);
});
