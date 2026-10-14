import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildCharacterCatalog, buildPostingTemplates, composePostingTemplate, matchPostingTemplates } from '../server/posting-templates.mjs';
import { planManualCharacterTags } from '../server/manual-character-tags.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/posting-history.json', import.meta.url)));
const memory = { id: 'ruan', englishName: 'RuanMei', gameTags: ['HonkaiStarRail', '崩坏星穹铁道'], characterTags: ['RuanMei'] };
const ownCommon = { 'Example Alpha': ['RuanMei', '花火(スターレイル)'], 'Example Beta': ['RuanMei', '花火(スターレイル)', '火花(スターレイル)'] };
const options = account => {
  const source = fixture.liveAccounts.find(item => item.account === account);
  return { scope: { mode: 'live', accountId: account, pixivUserId: source.pixivUserId },
    evidence: { checkedAt: fixture.checkedAt, recentWorks: source.history, frequentTags: ownCommon[account] },
    characters: [memory], sharedVerifiedTags: ['火花(スターレイル)'] };
};
const find = (catalog, name) => { const matches = matchPostingTemplates(catalog, name); assert.equal(matches.length, 1, name); return matches[0]; };
const scope = { mode: 'live', accountId: 'test', pixivUserId: '1' };
const work = (artworkId, title, tags) => ({ artworkId: String(artworkId), title, tags });

test('supplemental identities leave all 12 synthetic histories byte-for-byte unchanged', () => {
  for (const account of ['Example Alpha', 'Example Beta']) {
    const input = options(account), old = buildPostingTemplates(input), combined = buildCharacterCatalog(input);
    assert.deepEqual(combined.templates.slice(0, old.templates.length), old.templates);
    assert.equal(combined.historyTemplateCount, old.templates.length);
    assert.ok(combined.supplementalTemplateCount > 0);
    assert.equal(matchPostingTemplates(combined, 'Robin').length, 1);
  }
});

test('remembered RuanMei borrows each account own game spellings and rating position', () => {
  const alpha = find(buildCharacterCatalog(options('Example Alpha')), 'Ruan Mei');
  const beta = find(buildCharacterCatalog(options('Example Beta')), '阮梅');
  assert.deepEqual(alpha.gameTags, ['崩壊スターレイル', 'HonkaiStarRail']);
  assert.deepEqual(beta.gameTags, ['HonkaiStarRail', '崩坏星穹铁道']);
  assert.deepEqual(composePostingTemplate(alpha, { rating: 'r18' }).tags,
    ['R-18', '崩壊スターレイル', 'HonkaiStarRail', 'RuanMei', '女の子']);
  assert.deepEqual(composePostingTemplate(beta, { rating: 'all' }).tags,
    ['HonkaiStarRail', '崩坏星穹铁道', 'RuanMei', '女の子']);
  for (const template of [alpha, beta]) {
    assert.equal(template.source, 'account-style'); assert.equal(template.identitySource, 'user-memory');
    assert.equal(template.sampleCount, 0); assert.deepEqual(template.sourceArtworkIds, []);
    assert.ok(template.formatSourceArtworkIds.length > 0);
    assert.equal(template.formatSource, 'account-history');
    assert.equal(template.englishName, 'RuanMei');
  }
});

test('Sparxie and Sparkle stay separate; a shared verified tag never imports account formatting', () => {
  const alpha = buildCharacterCatalog(options('Example Alpha')), beta = buildCharacterCatalog(options('Example Beta'));
  const sparxieAlpha = find(alpha, 'Sparxie'), sparxieBeta = find(beta, '火花(スターレイル)');
  assert.equal(sparxieAlpha.identitySource, 'verified-tag-library');
  assert.equal(sparxieBeta.identitySource, 'account-common-tags');
  assert.deepEqual(sparxieAlpha.characterTags, ['火花(スターレイル)']);
  assert.deepEqual(find(alpha, 'Sparkle').characterTags, ['花火(スターレイル)']);
  assert.notEqual(find(alpha, 'Sparkle').id, sparxieAlpha.id);
  assert.deepEqual(sparxieAlpha.gameTags, ['崩壊スターレイル', 'HonkaiStarRail']);
  assert.deepEqual(sparxieBeta.gameTags, ['HonkaiStarRail', '崩坏星穹铁道']);
  const result = composePostingTemplate(sparxieAlpha, { rating: 'r18' });
  assert.equal(result.source, 'account-style'); assert.equal(result.identitySource, 'verified-tag-library');
  assert.deepEqual(result.sourceArtworkIds, []); assert.ok(result.formatSourceArtworkIds.length);
});

test('supplemental formats use old scene vocabulary only with current picture evidence', () => {
  const recentWorks = [1, 2, 3].map(id => work(id, 'Robin', ['HonkaiStarRail', 'R-18', 'ロビン(スターレイル)', '女の子', '水着', '黒タイツ', 'パイズリ']));
  const catalog = buildCharacterCatalog({ scope, evidence: { recentWorks, checkedAt: fixture.checkedAt, frequentTags: ['RuanMei'] } });
  const template = find(catalog, 'RuanMei');
  assert.deepEqual(template.conditionalTags, ['水着', '黒タイツ', 'パイズリ']);
  assert.deepEqual(composePostingTemplate(template, { rating: 'all' }).tags, ['HonkaiStarRail', 'RuanMei', '女の子']);
  assert.deepEqual(composePostingTemplate(template, { rating: 'all', sceneTags: ['黒タイツ'] }).tags,
    ['HonkaiStarRail', 'RuanMei', '女の子', '黒タイツ']);
  assert.deepEqual(composePostingTemplate(template, { rating: 'all', predictions: [{ name: 'swimsuit', category: 0, score: .95 }] }).tags,
    ['HonkaiStarRail', 'RuanMei', '女の子', '水着']);
  assert.deepEqual(composePostingTemplate(template, { rating: 'all', predictions: [{ name: 'swimsuit', category: 0, score: .75 }] }).tags,
    ['HonkaiStarRail', 'RuanMei', '女の子']);
});

test('a manually pinned name and unchecked common list are not identity evidence', () => {
  for (const evidence of [
    { preferredTags: ['RuanMei', 'HonkaiStarRail'], checkedAt: fixture.checkedAt },
    { frequentTags: ['RuanMei', 'HonkaiStarRail'] },
  ]) assert.equal(buildCharacterCatalog({ scope, evidence }).templates.length, 0);
  assert.equal(buildCharacterCatalog({ scope, evidence: {}, sharedVerifiedTags: ['火花(スターレイル)'] }).templates.length, 0,
    'a shared character cannot manufacture an account game format');
});

test('without same-game history use verified current-account game tags and disclose that fallback', () => {
  const evidence = { checkedAt: fixture.checkedAt, frequentTags: ['崩壊スターレイル', 'HonkaiStarRail', 'RuanMei'] };
  const template = find(buildCharacterCatalog({ scope, evidence, characters: [memory] }), 'RuanMei');
  assert.deepEqual(template.gameTags, ['崩壊スターレイル', 'HonkaiStarRail']);
  assert.equal(template.formatSource, 'verified-account-tags');
  assert.deepEqual(template.formatSourceArtworkIds, []);
  assert.deepEqual(composePostingTemplate(template, { rating: 'r18' }).tags,
    ['崩壊スターレイル', 'HonkaiStarRail', 'R-18', 'RuanMei']);
  const remembered = find(buildCharacterCatalog({ scope, characters: [memory] }), 'RuanMei');
  assert.equal(remembered.formatSource, 'user-memory');
});

test('same English name in different games remains separate and exact selection is required', () => {
  const characters = [memory, { id: 'other', englishName: 'RuanMei', gameTags: ['原神'], characterTags: ['CustomRuan'] }];
  const catalog = buildCharacterCatalog({ scope, characters });
  const matches = matchPostingTemplates(catalog, 'RuanMei');
  assert.equal(matches.length, 2); assert.notEqual(matches[0].id, matches[1].id);
  assert.deepEqual(find(catalog, 'CustomRuan').gameTags, ['原神']);
});

test('proof objects reject unverified or foreign-host tags and honor excluded identity tags', () => {
  const evidence = { checkedAt: fixture.checkedAt, frequentTags: ['HonkaiStarRail'] };
  const proof = { tag: '火花(スターレイル)', checkedAt: fixture.checkedAt, url: 'https://www.pixiv.net/illustration/create' };
  assert.equal(buildCharacterCatalog({ scope, evidence, sharedVerifiedTags: [{ ...proof, verified: false }] }).templates.length, 0);
  assert.equal(buildCharacterCatalog({ scope, evidence, sharedVerifiedTags: [{ ...proof, url: 'https://example.com/' }] }).templates.length, 0);
  assert.equal(buildCharacterCatalog({ scope, evidence: { ...evidence, excludedTags: [proof.tag] }, sharedVerifiedTags: [proof] }).templates.length, 0);
  assert.equal(find(buildCharacterCatalog({ scope, evidence, sharedVerifiedTags: [proof] }), 'Sparxie').identitySource, 'verified-tag-library');
});

test('RuanMei and Sparxie vocabulary is searchable without claiming any image identification', () => {
  for (const name of ['RuanMei', 'Ruan Mei', '阮梅']) {
    const plan = planManualCharacterTags({ name });
    assert.equal(plan.status, 'resolved'); assert.equal(plan.identity.englishName, 'RuanMei');
    assert.ok(plan.queries.some(query => query.word === 'RuanMei'));
  }
  const sparxie = planManualCharacterTags({ name: 'Sparxie' });
  assert.equal(sparxie.status, 'resolved');
  assert.ok(sparxie.queries.some(query => query.word === '火花(スターレイル)'));
  assert.ok(!sparxie.queries.some(query => query.word === '花火(スターレイル)'));
});

test('catalog construction preserves inputs and binds synthetic IDs to mode and account', () => {
  const input = options('Example Alpha'), snapshot = structuredClone(input);
  const live = find(buildCharacterCatalog(input), 'RuanMei');
  const demo = find(buildCharacterCatalog({ ...input, scope: { ...input.scope, mode: 'demo' } }), 'RuanMei');
  assert.notEqual(live.id, demo.id); assert.deepEqual(input, snapshot);
});
