import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCharacterMemory } from '../server/character-recall.mjs';
import { tagQueries, rankPixivTags, selectAutomaticTags } from '../server/recognition.mjs';

const identity = { id: 'robin', englishName: 'Robin', gameTags: ['HonkaiStarRail'], characterTags: ['ロビン(スターレイル)'], sampleCount: 1 };
function result() { return { source: 'local', analyzedFiles: [{ id: 'a', sha256: 'a'.repeat(64) }],
  predictions: [{ name: '1girl', category: 0, score: .99, fileId: 'a' }, { name: 'robin_(fire_emblem)', category: 4, score: .96, fileId: 'a' }],
  candidates: [{ tag: 'Wrong Robin', modelNames: ['robin_(fire_emblem)'] }], unmapped: [{ name: 'robin_(fire_emblem)', category: 4 }],
  recognition: { title: 'Robin', rating: 'r18', sexualContent: null, perFile: [{ fileId: 'a', single: true, multiple: false }], characters: [{ name: 'robin_(fire_emblem)', confidence: .96 }] } }; }
test('explicit same-image correction replaces identity, preserves current rating, and feeds verified ordered tag matching', async () => {
  const original = result();
  const recalled = await applyCharacterMemory(original, { match: async () => ({ exact: identity, candidates: [] }) }, 'live');
  assert.equal(recalled.recognition.title, 'Robin');
  assert.equal(recalled.recognition.rating, 'r18');
  assert.equal(recalled.recognition.characters[0].source, 'user-confirmed-image');
  assert.equal(recalled.predictions.some(p => p.name === 'robin_(fire_emblem)'), false);
  assert.equal(recalled.candidates.length, 0);
  assert.equal(original.predictions.length, 2, 'caller data remains unchanged');
  const queries = tagQueries(recalled.predictions, recalled.candidates, recalled.recognition);
  assert.ok(queries.some(q => q.word === 'ロビン(スターレイル)'));
  assert.ok(!queries.some(q => q.word.startsWith('Memory:')));
  const candidates = rankPixivTags(queries, { frequentTags: ['ロビン(スターレイル)'], matches: queries.map(q => ({ word: q.word, tag: q.word })), checkedAt: new Date().toISOString() });
  assert.deepEqual(selectAutomaticTags(candidates, recalled.recognition).slice(0, 3), ['HonkaiStarRail', 'R-18', 'ロビン(スターレイル)']);
  assert.deepEqual(selectAutomaticTags([], recalled.recognition), [], 'remembered aliases alone are not Pixiv tag evidence');
});
test('similarity candidates never become identity or title automatically, even at perfect descriptor similarity', async () => {
  const original = result(); original.recognition.title = ''; original.recognition.characters = [];
  const recalled = await applyCharacterMemory(original, { match: async () => ({ exact: null, candidates: [{ ...identity, similarity: 1 }] }) }, 'live');
  assert.equal(recalled.recognition.title, '');
  assert.deepEqual(recalled.predictions, original.predictions);
  assert.equal(recalled.recognition.memory.candidates[0].englishName, 'Robin');
});
test('multi-image or multiple-person results cannot recall a single character title', async () => {
  const memory = { match: () => { throw new Error('Must not attempt recall'); } };
  const multiple = result(); multiple.recognition.perFile[0].multiple = true;
  assert.equal(await applyCharacterMemory(multiple, memory, 'live'), multiple);
  const album = result(); album.analyzedFiles.push({ id: 'b' });
  assert.equal(await applyCharacterMemory(album, memory, 'live'), album);
});
