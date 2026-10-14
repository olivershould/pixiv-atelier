import test from 'node:test';
import assert from 'node:assert/strict';
import { planManualCharacterTags, resolveManualCharacterTags } from '../server/manual-character-tags.mjs';

const checkedAt = '2026-10-13T02:00:00.000Z';
const proof = (plan, { tags = plan.queries.map(query => query.word), cached = false, ...other } = {}) => ({ checkedAt, cached,
  ...(cached ? { source: 'pixiv-cache' } : {}), ...other,
  matches: plan.queries.filter(query => tags.includes(query.word)).map(query => ({ word: query.word, tag: query.word,
    url: 'https://www.pixiv.net/illustration/create', checkedAt, ...(cached ? { source: 'pixiv-cache', verified: true } : {}) })) });
const robin = { id: 'robin-memory', englishName: 'Robin', gameTags: ['崩坏星穹铁道', '崩壊:スターレイル'], characterTags: ['ロビン(スターレイル)'] };

test('complete explicit character memory fills game and character tags without claiming Pixiv verification', () => {
  const snapshot = structuredClone(robin);
  const plan = planManualCharacterTags({ name: 'robin', characters: [robin], evidence: { preferredTags: ['崩壊:スターレイル'] } });
  const result = resolveManualCharacterTags(plan);
  assert.equal(result.status, 'resolved');
  assert.equal(result.source, 'user-memory');
  assert.deepEqual(result.gameTags, ['崩壊:スターレイル', '崩坏星穹铁道']);
  assert.deepEqual(result.characterTags, ['ロビン(スターレイル)']);
  assert.deepEqual(result.tags, [...result.gameTags, ...result.characterTags]);
  assert.deepEqual(result.evidence, [{ kind: 'user_character_memory', id: 'memory:robin-memory' }]);
  assert.deepEqual(robin, snapshot, 'pure helpers never modify memory');
});
test('same name memory in different games is ambiguous and does not select the first record', () => {
  const plan = planManualCharacterTags({ name: 'Robin', characters: [robin,
    { id: 'fire-emblem', englishName: 'Robin', gameTags: ['FireEmblem'], characterTags: ['ルフレ'] }] });
  assert.equal(plan.status, 'ambiguous');
  assert.equal(plan.candidates.length, 2);
  assert.deepEqual(plan.queries, []);
  assert.deepEqual(resolveManualCharacterTags(plan).tags, []);
  assert.equal(planManualCharacterTags({ name: 'ルフレ', characters: [robin,
    { id: 'fire-emblem', englishName: 'Robin', gameTags: ['FireEmblem'], characterTags: ['ルフレ'] }] }).status, 'resolved');
});
test('known aliases are search vocabulary and require exact proof for both game and character', () => {
  const plan = planManualCharacterTags({ name: 'Mona' });
  assert.equal(plan.status, 'resolved');
  assert.ok(plan.queries.some(query => query.word === 'モナ(原神)' && query.tagRole === 'character'));
  assert.deepEqual(resolveManualCharacterTags(plan).tags, []);
  assert.deepEqual(resolveManualCharacterTags(plan, proof(plan, { tags: ['原神'] })).tags, []);
  const result = resolveManualCharacterTags(plan, proof(plan, { tags: ['原神', 'モナ(原神)'] }));
  assert.deepEqual(result.tags, ['原神', 'モナ(原神)']);
  assert.equal(result.source, 'pixiv');
});
test('historical names use scoped identities and preserve repeatedly paired account game spellings', () => {
  const recentWorks = [1, 2].map(artworkId => ({ artworkId: String(artworkId), title: 'Robin',
    tags: ['R-18', 'HonkaiStarRail', '崩壊スターレイル', 'ロビン(スターレイル)', '極上の女体', 'おへそ'] }));
  const evidence = { recentWorks, frequentTags: ['HonkaiStarRail', '崩壊スターレイル', 'ロビン(スターレイル)'], preferredTags: ['崩壊スターレイル', 'HonkaiStarRail'] };
  const plan = planManualCharacterTags({ name: 'Robin', evidence });
  assert.equal(plan.status, 'resolved');
  assert.ok(!plan.queries.some(query => ['R-18', '極上の女体', 'おへそ'].includes(query.word)));
  const result = resolveManualCharacterTags(plan, proof(plan, { cached: true, ...evidence, tags: ['HonkaiStarRail', '崩壊スターレイル', 'ロビン(スターレイル)'] }));
  assert.deepEqual(result.tags, ['HonkaiStarRail', '崩壊スターレイル', 'ロビン(スターレイル)']);
  assert.equal(result.source, 'pixiv-cache');
  assert.ok(result.evidence.every(item => item.cached && item.checkedAt === checkedAt));
});
test('new names require observed verified account associations; manual pins and scene-only old titles are insufficient', () => {
  assert.equal(planManualCharacterTags({ name: 'Robin', evidence: { preferredTags: ['Robin', 'ロビン(スターレイル)', 'HonkaiStarRail'] } }).status, 'not-found');
  for (const [name, tag] of [['Firefly', 'ホタル(スターレイル)'], ['Sparkle', '花火(スターレイル)']]) {
    assert.equal(planManualCharacterTags({ name }).status, 'not-found');
    const plan = planManualCharacterTags({ name, evidence: { frequentTags: [tag] } });
    assert.equal(plan.status, 'resolved');
    assert.ok(plan.queries.some(query => query.word === tag));
  }
  const plan = planManualCharacterTags({ name: 'Sunset', evidence: { recentWorks: [{ title: 'Sunset', tags: ['原神', '女の子', '極上の女体', 'おへそ'] }] } });
  assert.equal(plan.status, 'not-found');
  assert.deepEqual(plan.queries, []);
});
test('exact English historical title plus scoped tag learns the label association without guessing other scene tags', () => {
  const plan = planManualCharacterTags({ name: 'Castorice', evidence: { recentWorks: [{ title: 'Castorice', tags: ['崩壊スターレイル', 'キャストリス(スターレイル)', '極上の女体'] }] } });
  assert.equal(plan.status, 'resolved');
  assert.ok(plan.queries.some(query => query.word === 'キャストリス(スターレイル)'));
  assert.ok(!plan.queries.some(query => query.word === '極上の女体'));
  const conflicting = planManualCharacterTags({ name: 'Group', evidence: { recentWorks: [{ title: 'Group', tags: ['原神', 'モナ(原神)', '甘雨(原神)'] }] } });
  assert.equal(conflicting.status, 'ambiguous');
});
test('prefix suggestions, unverified cache, wrong host and removed tags cannot auto-fill', () => {
  const plan = planManualCharacterTags({ name: 'Mona' });
  const searched = proof(plan, { tags: ['原神', 'モナ(原神)'], cached: true });
  const wrong = structuredClone(searched); wrong.matches[1].tag += 'cosplay';
  assert.equal(resolveManualCharacterTags(plan, wrong).status, 'not-found');
  const unverified = structuredClone(searched); delete unverified.matches[1].verified;
  assert.equal(resolveManualCharacterTags(plan, unverified).status, 'not-found');
  const badHost = structuredClone(searched); badHost.matches[1].url = 'https://example.com/tag';
  assert.equal(resolveManualCharacterTags(plan, badHost).status, 'not-found');
  assert.equal(resolveManualCharacterTags(plan, { ...searched, excludedTags: ['モナ(原神)'] }).status, 'not-found');
});
test('incomplete memory needs actual proof for any inferred labels and cannot turn English title into a scene tag', () => {
  const plan = planManualCharacterTags({ name: 'Mona', characters: [{ id: 'mona', englishName: 'Mona', gameTags: [], characterTags: [] }] });
  assert.equal(plan.status, 'resolved');
  assert.deepEqual(resolveManualCharacterTags(plan).tags, []);
  assert.deepEqual(resolveManualCharacterTags(plan, proof(plan, { tags: ['原神', 'モナ(原神)'] })).tags, ['原神', 'モナ(原神)']);
  const gameOnly = planManualCharacterTags({ name: 'Mona', characters: [{ id: 'mona', englishName: 'Mona', gameTags: ['原神'], characterTags: [] }] });
  assert.deepEqual(resolveManualCharacterTags(gameOnly, proof(gameOnly, { tags: ['原神', 'モナ(原神)'] })).tags, ['原神', 'モナ(原神)']);
});
test('a misleading exact historical title cannot merge a different scoped identity into a known name', () => {
  for (const [name, gameTag, correct, wrong] of [
    ['Robin', 'HonkaiStarRail', 'ロビン(スターレイル)', 'カフカ(スターレイル)'],
    ['Mona', '原神', 'モナ(原神)', 'リサ(原神)'],
  ]) {
    const plan = planManualCharacterTags({ name, evidence: { frequentTags: [gameTag, correct], recentWorks: [{ title: name, tags: [gameTag, wrong] }] } });
    assert.equal(plan.status, 'ambiguous', name);
    assert.deepEqual(plan.queries, []);
    assert.deepEqual(resolveManualCharacterTags(plan).tags, []);
  }
  const unknown = planManualCharacterTags({ name: 'NewName', evidence: { recentWorks: [
    { title: 'NewName', tags: ['原神', 'モナ(原神)'] }, { title: 'NewName', tags: ['原神', 'リサ(原神)'] },
  ] } });
  assert.equal(unknown.status, 'ambiguous');
});
test('actual Evernight and TheHerta history aliases require an established game association', () => {
  for (const [name, tag] of [['Evernight', '長夜月'], ['The Herta', 'マダム・ヘルタ']]) {
    assert.equal(planManualCharacterTags({ name }).status, 'not-found');
    assert.equal(planManualCharacterTags({ name, evidence: { preferredTags: [tag] } }).status, 'not-found');
    const evidence = { recentWorks: [{ title: name.replaceAll(' ', ''), tags: ['HonkaiStarRail', '崩壊スターレイル', tag, '女の子', '水着'] }] };
    const plan = planManualCharacterTags({ name, evidence });
    assert.equal(plan.status, 'resolved');
    assert.ok(!plan.queries.some(query => ['女の子', '水着'].includes(query.word)));
    assert.deepEqual(resolveManualCharacterTags(plan, proof(plan, { ...evidence, tags: ['HonkaiStarRail', tag] })).tags, ['HonkaiStarRail', tag]);
  }
});
test('actual Ellen history supports established English variants without inventing other identities', () => {
  const evidence = { frequentTags: ['EllenJoe'], recentWorks: [{ title: 'Ellen', tags: ['ZenlessZoneZero', '绝区零', 'EllenJoe'] }] };
  for (const name of ['Ellen', 'Ellen Joe', 'EllenJoe']) {
    const plan = planManualCharacterTags({ name, evidence });
    assert.equal(plan.status, 'resolved', name);
    assert.deepEqual(resolveManualCharacterTags(plan, proof(plan, { ...evidence, tags: ['ZenlessZoneZero', 'EllenJoe'] })).tags, ['ZenlessZoneZero', 'EllenJoe']);
  }
});
test('a user-entered existing scoped tag resolves its game without requiring a known English alias', () => {
  for (const [name, game] of [['NewCharacter(スターレイル)', 'HonkaiStarRail'], ['NewCharacter(ゼンゼロ)', 'ZenlessZoneZero'], ['ロビン(スターレイル)', 'HonkaiStarRail']]) {
    assert.equal(planManualCharacterTags({ name, evidence: { preferredTags: [name, game] } }).status, 'not-found');
    const evidence = { frequentTags: [name, game] };
    const plan = planManualCharacterTags({ name, evidence });
    assert.equal(plan.status, 'resolved');
    const result = resolveManualCharacterTags(plan, proof(plan, { ...evidence, cached: true, tags: [name, game] }));
    assert.deepEqual(result.tags, [game, name]);
  }
});
