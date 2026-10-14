import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildPostingTemplates, composePostingTemplate, matchPostingTemplates } from '../server/posting-templates.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/posting-history.json', import.meta.url)));
const catalogFor = account => {
  const source = fixture.liveAccounts.find(item => item.account === account);
  return buildPostingTemplates({ scope: { mode: 'live', accountId: source.account, pixivUserId: source.pixivUserId },
    evidence: { recentWorks: source.history, checkedAt: fixture.checkedAt } });
};
const build = recentWorks => buildPostingTemplates({ scope: { mode: 'live', accountId: 'test', pixivUserId: '123' }, evidence: { recentWorks } });
const work = (artworkId, title, tags) => ({ artworkId: String(artworkId), title, tags });
const core = ['HonkaiStarRail', '崩坏星穹铁道', 'ロビン(スターレイル)'];

test('the 12 synthetic works build 11 scoped identities and retain all original variants', () => {
  const alpha = catalogFor('Example Alpha'), beta = catalogFor('Example Beta');
  assert.equal(alpha.historyCount, 6); assert.equal(beta.historyCount, 6);
  assert.equal(alpha.templates.length, 5); assert.equal(beta.templates.length, 6);
  assert.deepEqual([...alpha.unresolvedWorks, ...beta.unresolvedWorks], []);
  for (const source of fixture.liveAccounts) for (const old of source.history) {
    const matches = matchPostingTemplates(source.account === 'Example Alpha' ? alpha : beta, old.title);
    assert.equal(matches.length, 1, old.title);
    assert.ok(matches[0].variants.some(variant => JSON.stringify(variant.orderedTags) === JSON.stringify(old.tags)));
  }
});

test('account spelling and order override the other account shared character memory', () => {
  const source = fixture.liveAccounts.find(item => item.account === 'Example Beta');
  const catalog = buildPostingTemplates({ scope: { mode: 'live', accountId: 'Example Beta', pixivUserId: source.pixivUserId },
    evidence: { recentWorks: source.history }, characters: [{ id: 'robin', englishName: 'Robin',
      gameTags: ['崩壊スターレイル', 'HonkaiStarRail'], characterTags: ['ロビン(スターレイル)'] }] });
  const beta = matchPostingTemplates(catalog, 'Robin')[0], alpha = matchPostingTemplates(catalogFor('Example Alpha'), 'Robin')[0];
  assert.deepEqual(beta.gameTags, core.slice(0, 2));
  assert.deepEqual(alpha.gameTags, ['崩壊スターレイル', 'HonkaiStarRail']);
  assert.notEqual(beta.id, alpha.id);
  assert.deepEqual(composePostingTemplate(beta, { rating: 'all' }).tags, [...core, '女の子']);
});

test('Sunna keeps all three exact game labels from a single historical work', () => {
  const template = matchPostingTemplates(catalogFor('Example Beta'), '千夏(ゼンゼロ)')[0];
  assert.deepEqual(template.gameTags, ['绝区零', 'ゼンレスゾーンゼロ', 'ZenlessZoneZero']);
  assert.deepEqual(composePostingTemplate(template, { rating: 'all' }).tags,
    ['绝区零', 'ゼンレスゾーンゼロ', 'ZenlessZoneZero', '千夏(ゼンゼロ)', '女の子']);
});

test('current rating replaces old restrictions while respecting historical rating placement', () => {
  const alpha = matchPostingTemplates(catalogFor('Example Alpha'), 'Robin')[0];
  assert.equal(composePostingTemplate(alpha, { rating: 'r18' }).tags[0], 'R-18');
  assert.equal(composePostingTemplate(alpha, { rating: 'r18g' }).tags[0], 'R-18G');
  for (const rating of ['all', null, undefined]) assert.ok(!composePostingTemplate(alpha, { rating }).tags.some(tag => tag.startsWith('R-18')));
  const beta = matchPostingTemplates(catalogFor('Example Beta'), 'Robin')[0];
  assert.deepEqual(composePostingTemplate(beta, { rating: 'r18' }).tags.slice(0, 4), [...core.slice(0, 2), 'R-18', core[2]]);
  const jean = matchPostingTemplates(catalogFor('Example Alpha'), 'Jean')[0];
  assert.equal(composePostingTemplate(jean, { rating: 'r18' }).tags[0], 'R-18', 'account placement applies to a previously general-rated character');
});

test('clothes, actions and unknown labels never become automatic bases from frequency alone', () => {
  const recentWorks = [1, 2, 3, 4].map(id => work(id, 'Robin', [...core, '女の子', '水着', '黒タイツ', 'パイズリ', 'unexplained label']));
  const template = build(recentWorks).templates[0];
  assert.deepEqual(template.baseTags, ['女の子']);
  assert.deepEqual(composePostingTemplate(template, { rating: 'all' }).tags, [...core, '女の子']);
  assert.deepEqual(composePostingTemplate(template, { rating: 'all' }).optionalTags, ['水着', '黒タイツ', 'パイズリ', 'unexplained label']);
  assert.deepEqual(composePostingTemplate(template, { rating: 'all', predictions: [{ category: 0, name: 'swimsuit', score: .95 }] }).tags,
    [...core, '女の子', '水着']);
  assert.ok(!composePostingTemplate(template, { predictions: [{ category: 0, name: 'swimsuit', score: .5 }] }).tags.includes('水着'));
});

test('base defaults require three distinct published works and at least 60 percent of history', () => {
  assert.deepEqual(build([work(1, 'Robin', [...core, '女の子']), work(2, 'Robin', [...core, '女の子'])]).templates[0].baseTags, []);
  const recentWorks = [1, 2, 3, 4, 5, 6].map(id => work(id, 'Robin', [...core, ...(id <= 3 ? ['女の子'] : [])]));
  assert.deepEqual(build(recentWorks).templates[0].baseTags, []);
  const dedup = build([work(1, 'Robin', [...core, '女の子']), work(1, 'Robin', [...core, '女の子']), work(1, 'Robin', [...core, '女の子'])]);
  assert.equal(dedup.historyCount, 1); assert.deepEqual(dedup.templates[0].baseTags, []);
});

test('same-character conditional variants are selected with current evidence, not merged blindly', () => {
  const template = matchPostingTemplates(catalogFor('Example Alpha'), 'Ellen')[0];
  assert.equal(template.variants.length, 2);
  const bare = composePostingTemplate(template, { rating: 'r18', sceneTags: ['裸足', '妖姿媚態'] });
  assert.ok(bare.tags.includes('裸足')); assert.ok(!bare.tags.includes('おへそ'));
  assert.equal(bare.sourceArtworkIds[0], '1002');
  const navel = composePostingTemplate(template, { rating: 'r18', sceneTags: ['おへそ', '妖姿媚態'] });
  assert.ok(navel.tags.includes('おへそ')); assert.ok(!navel.tags.includes('裸足'));
  assert.equal(navel.sourceArtworkIds[0], '1003');
  assert.deepEqual(composePostingTemplate(template, { rating: 'r18' }).conditionalTags, []);
});

test('exact aliases match once; unrelated titles and ambiguous identities never auto-select', () => {
  const source = catalogFor('Example Alpha');
  assert.equal(matchPostingTemplates(source, 'silver_wolf_(honkai:_star_rail)').length, 1);
  assert.equal(matchPostingTemplates(source, 'Robin swimsuit').length, 0);
  const ambiguous = build([work(1, 'NewName', ['原神', 'モナ(原神)']), work(2, 'NewName', ['原神', 'リサ(原神)'])]);
  assert.equal(matchPostingTemplates(ambiguous, 'NewName').length, 2);
  const multiGame = build([work(1, 'Robin', [...core]), work(2, 'Robin', ['FireEmblem', 'Robin(Fire Emblem)'])]);
  assert.equal(matchPostingTemplates(multiGame, 'Robin').length, 2);
  const unknown = build([work(3, 'Sunset', ['原神', '女の子', '水着'])]);
  assert.equal(unknown.templates.length, 0); assert.equal(unknown.unresolvedWorks.length, 1);
});

test('literal case, spaces and fullwidth variants intentionally used together survive unchanged', () => {
  const tags = ['HonkaiStarRail', 'honkai_star_rail', 'ＨｏｎｋａｉＳｔａｒＲａｉｌ', 'ロビン(スターレイル)', 'sceneTag', 'scenetag'];
  const template = build([work(1, 'Robin', tags)]).templates[0];
  assert.deepEqual(template.orderedTags, tags);
  assert.deepEqual(composePostingTemplate(template, { rating: 'all', sceneTags: ['sceneTag'] }).tags, tags);
});

test('selecting a conditional variant also selects that variant exact identity format', () => {
  const newer = ['HonkaiStarRail', '崩坏星穹铁道', 'ロビン(スターレイル)', '水着'];
  const older = ['崩壊スターレイル', 'HonkaiStarRail', '知更鸟', '黒タイツ'];
  const catalog = build([work(1, 'Robin', newer), work(2, 'Robin', older)]);
  assert.equal(catalog.templates.length, 1);
  const result = composePostingTemplate(catalog.templates[0], { rating: 'all', sceneTags: ['黒タイツ'] });
  assert.deepEqual(result.tags, older);
  assert.deepEqual(result.gameTags, older.slice(0, 2));
  assert.deepEqual(result.characterTags, ['知更鸟']);
});

test('without distinguishing current evidence a frequent historical format stays primary', () => {
  const frequent = [...core, '黒タイツ', 'おへそ'];
  const rare = ['崩坏星穹铁道', '知更鸟'];
  const template = build([work(1, 'Robin', frequent), work(2, 'Robin', frequent), work(3, 'Robin', rare)]).templates[0];
  assert.deepEqual(composePostingTemplate(template, { rating: 'all' }).tags, core);
});

test('scene-only, multi-character, misleading, unverified and scheduled records cannot establish templates', () => {
  const result = build([
    work(1, 'Group', ['原神', 'モナ(原神)', '甘雨(原神)']),
    work(2, 'Mona', ['原神', 'リサ(原神)']),
    { ...work(3, 'Robin', core), verified: false },
    { ...work(4, 'Robin', core), status: 'scheduled' },
  ]);
  assert.equal(result.historyCount, 2); assert.equal(result.templates.length, 0); assert.equal(result.unresolvedWorks.length, 2);
});

test('tag limit preserves identity and current restriction even when those occur late in a variant', () => {
  const extra = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];
  const template = build([work(1, 'Robin', [...extra, ...core, 'R-18'])]).templates[0];
  const result = composePostingTemplate(template, { rating: 'r18g', sceneTags: extra });
  assert.equal(result.tags.length, 10);
  assert.deepEqual(result.tags.slice(-4), [...core, 'R-18G']);
});

test('templates retain local published provenance, isolate mode and never mutate inputs', () => {
  const evidence = { recentWorks: [{ ...work('local:draft-id', 'Robin', core), source: 'local-published' }] }, snapshot = structuredClone(evidence);
  const real = buildPostingTemplates({ scope: { mode: 'live', accountId: 'a', pixivUserId: '1' }, evidence });
  const demo = buildPostingTemplates({ scope: { mode: 'demo', accountId: 'a', pixivUserId: '1' }, evidence });
  assert.notEqual(real.templates[0].id, demo.templates[0].id);
  assert.deepEqual(real.templates[0].sources, [{ artworkId: 'local:draft-id', source: 'local-published' }]);
  const original = structuredClone(real.templates[0]); composePostingTemplate(real.templates[0], { rating: 'r18' });
  assert.deepEqual(real.templates[0], original); assert.deepEqual(evidence, snapshot);
});

test('synthetic format replay exactly preserves literal tags and their complete order with explicit scene evidence', () => {
  for (const source of fixture.liveAccounts) for (const old of source.history) {
    const template = matchPostingTemplates(catalogFor(source.account), old.title)[0];
    const rating = old.tags.includes('R-18G') ? 'r18g' : old.tags.includes('R-18') ? 'r18' : 'all';
    const composed = composePostingTemplate(template, { rating, sceneTags: old.tags.filter(tag => template.tagRoles[tag] === 'scene') });
    assert.deepEqual(composed.tags, old.tags, `${source.account} / ${old.artworkId}`);
  }
});
