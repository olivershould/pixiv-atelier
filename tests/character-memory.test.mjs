import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCharacterMemory } from '../server/character-memory.mjs';

const hash = value => value.toString(16).padStart(64, '0');
const descriptor = (similarity = 1, modelSha256 = hash(100)) => ({
  version: 'wd-swinv2-v3-pooled-v1', modelSha256,
  values: [similarity, Math.sqrt(1 - similarity ** 2), ...Array(1022).fill(0)],
});
const reference = (overrides = {}) => ({
  mode: 'live', englishName: 'robin', gameTags: ['HonkaiStarRail'],
  characterTags: ['ロビン(スターレイル)'], fileId: 'upload-1', sha256: hash(1),
  descriptor: descriptor(), confirmedSingleCharacter: true, ...overrides,
});
async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'huaxu-character-memory-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  return { dataDir, filename: path.join(dataDir, 'character-memory.json'), memory: await createCharacterMemory({ dataDir }) };
}
const invalid = { code: 'CHARACTER_MEMORY_INVALID_INPUT', status: 400 };

test('manual identity persists, uses English title capitalization, and never exposes embeddings', async t => {
  const { memory, dataDir } = await fixture(t);
  assert.deepEqual(await memory.list({ mode: 'live' }), []);
  const saved = await memory.remember(reference({ englishName: 'the herta', characterTags: [' ヘルタ（スターレイル） '] }));
  assert.equal(saved.englishName, 'The Herta');
  assert.deepEqual(saved.characterTags, ['ヘルタ（スターレイル）']);
  assert.equal(saved.sampleCount, 1);
  assert.equal(Object.hasOwn(saved.samples[0], 'descriptor'), false);
  assert.equal(JSON.stringify(saved).includes('values'), false);
  const reopened = await createCharacterMemory({ dataDir });
  assert.deepEqual(await reopened.list({ mode: 'live' }), [saved]);
  const found = await reopened.match({ mode: 'live', sha256: hash(1) });
  assert.deepEqual(found, { exact: saved, candidates: [] });
  saved.gameTags.push('Unrelated');
  found.exact.samples[0].fileId = 'tampered';
  assert.deepEqual((await reopened.list({ mode: 'live' }))[0].gameTags, ['HonkaiStarRail']);
  assert.equal((await reopened.list({ mode: 'live' }))[0].samples[0].fileId, 'upload-1');
});

test('shared identities are available without an account key while demo and live stay isolated', async t => {
  const { memory, dataDir } = await fixture(t);
  const live = await memory.remember(reference());
  assert.equal((await memory.match({ mode: 'live', sha256: hash(1) })).exact.id, live.id);
  assert.deepEqual(await memory.match({ mode: 'demo', sha256: hash(1), descriptor: descriptor() }), { exact: null, candidates: [] });
  const demo = await memory.remember(reference({ mode: 'demo', englishName: 'mona' }));
  assert.notEqual(demo.id, live.id);
  assert.equal((await memory.match({ mode: 'live', sha256: hash(1) })).exact.englishName, 'Robin');
  assert.equal((await memory.match({ mode: 'demo', sha256: hash(1) })).exact.englishName, 'Mona');
  await memory.forget({ mode: 'demo', id: demo.id });
  assert.equal((await (await createCharacterMemory({ dataDir })).list({ mode: 'live' })).length, 1);
  assert.deepEqual(await memory.list({ mode: 'demo' }), []);
});

test('confirming an existing image is idempotent and adding references can use the explicit character ID', async t => {
  const { memory } = await fixture(t);
  const first = await memory.remember(reference());
  const again = await memory.remember(reference({ fileId: 'uploaded-again' }));
  assert.equal(again.id, first.id);
  assert.equal(again.sampleCount, 1);
  assert.equal(again.samples[0].fileId, 'uploaded-again');
  assert.equal(again.samples[0].addedAt, first.samples[0].addedAt);
  const second = await memory.remember(reference({ characterId: first.id, fileId: 'upload-2', sha256: hash(2), characterTags: ['ロビン(スターレイル)', 'Robin'] }));
  assert.equal(second.sampleCount, 2);
  assert.deepEqual(second.characterTags, ['ロビン(スターレイル)', 'Robin']);
  assert.equal((await memory.list({ mode: 'live' })).length, 1);
  assert.equal((await memory.match({ mode: 'live', sha256: hash(2) })).exact.id, first.id);
});

test('correcting the same image moves it to the new identity and removes an empty old identity', async t => {
  const { memory, dataDir } = await fixture(t);
  const wrong = await memory.remember(reference({ englishName: 'firefly' }));
  const right = await memory.remember(reference({ englishName: 'robin', descriptor: null }));
  assert.notEqual(right.id, wrong.id);
  assert.deepEqual((await memory.list({ mode: 'live' })).map(item => item.id), [right.id]);
  const reopened = await createCharacterMemory({ dataDir });
  assert.equal((await reopened.match({ mode: 'live', sha256: hash(1) })).exact.englishName, 'Robin');
  assert.equal((await reopened.match({ mode: 'live', sha256: hash(99), descriptor: descriptor() })).candidates[0].id, right.id);
});

test('correcting one reference preserves other references and unrelated identities', async t => {
  const { memory } = await fixture(t);
  const previous = await memory.remember(reference({ englishName: 'firefly' }));
  await memory.remember(reference({ englishName: 'firefly', sha256: hash(2), fileId: 'upload-2' }));
  const correction = await memory.remember(reference());
  assert.equal((await memory.match({ mode: 'live', sha256: hash(1) })).exact.id, correction.id);
  assert.equal((await memory.match({ mode: 'live', sha256: hash(2) })).exact.id, previous.id);
  assert.equal((await memory.list({ mode: 'live' })).find(item => item.id === previous.id).sampleCount, 1);
});

test('explicit identity updates are persistent and a colliding identity name is rejected', async t => {
  const { memory, dataDir } = await fixture(t);
  const old = await memory.remember(reference({ englishName: 'march' }));
  const updated = await memory.remember(reference({ characterId: old.id, englishName: 'march 7th' }));
  assert.equal(updated.id, old.id);
  assert.equal((await (await createCharacterMemory({ dataDir })).list({ mode: 'live' }))[0].englishName, 'March 7th');
  const robin = await memory.remember(reference({ sha256: hash(2), fileId: 'upload-2' }));
  await assert.rejects(memory.remember(reference({ characterId: robin.id, englishName: 'March 7th' })), invalid);
  assert.equal((await memory.list({ mode: 'live' })).length, 2);
  await assert.rejects(memory.remember(reference({ characterId: '11111111-1111-4111-8111-111111111111' })), { code: 'CHARACTER_MEMORY_NOT_FOUND', status: 404 });
});

test('same English name in different games remains distinct and produces ambiguous suggestions', async t => {
  const { memory } = await fixture(t);
  const starRail = await memory.remember(reference());
  const fireEmblem = await memory.remember(reference({ gameTags: ['Fire Emblem'], characterTags: ['ルフレ'], sha256: hash(2), fileId: 'upload-2' }));
  const found = await memory.match({ mode: 'live', sha256: hash(99), descriptor: descriptor() });
  assert.equal(found.exact, null);
  assert.equal(found.candidates.length, 2);
  assert.deepEqual(new Set(found.candidates.map(item => item.id)), new Set([starRail.id, fireEmblem.id]));
  assert.ok(found.candidates.every(item => item.similarity === 1 && !Object.hasOwn(item, 'confidence')));
});

test('cosine matching groups each identity by its best compatible reference, ranks and limits candidates', async t => {
  const { memory } = await fixture(t);
  await memory.remember(reference({ englishName: 'robin', descriptor: descriptor(.81) }));
  await memory.remember(reference({ englishName: 'robin', descriptor: descriptor(.99), sha256: hash(2), fileId: 'upload-2' }));
  for (const [offset, englishName, similarity] of [[3, 'Firefly', .97], [4, 'Mona', .95], [5, 'Kafka', .9], [6, 'Nilou', .79]]) {
    await memory.remember(reference({ englishName, descriptor: descriptor(similarity), sha256: hash(offset), fileId: `upload-${offset}` }));
  }
  const match = await memory.match({ mode: 'live', sha256: hash(99), descriptor: descriptor() });
  assert.equal(match.exact, null);
  assert.deepEqual(match.candidates.map(item => item.englishName), ['Robin', 'Firefly', 'Mona']);
  assert.ok(Math.abs(match.candidates[0].similarity - .99) < 1e-10);
  assert.equal(match.candidates[0].sampleCount, 2);
  assert.ok(match.candidates.every(item => item.samples.every(sample => !Object.hasOwn(sample, 'descriptor'))));
  const exact = await memory.match({ mode: 'live', sha256: hash(1), descriptor: descriptor() });
  assert.equal(exact.exact.englishName, 'Robin');
  assert.ok(exact.candidates.every(item => item.id !== exact.exact.id));
});

test('exact hashes work without descriptors or across model changes while incompatible visual comparisons are skipped', async t => {
  const { memory } = await fixture(t);
  const first = await memory.remember(reference({ descriptor: null }));
  assert.equal((await memory.match({ mode: 'live', sha256: hash(1), descriptor: descriptor() })).exact.id, first.id);
  assert.deepEqual((await memory.match({ mode: 'live', sha256: hash(9), descriptor: descriptor() })).candidates, []);
  await memory.remember(reference());
  const otherModel = descriptor(1, hash(200));
  assert.deepEqual((await memory.match({ mode: 'live', sha256: hash(9), descriptor: otherModel })).candidates, []);
  assert.equal((await memory.match({ mode: 'live', sha256: hash(1), descriptor: otherModel })).exact.id, first.id);
  assert.equal((await memory.match({ mode: 'live', sha256: hash(1) })).exact.id, first.id);
});

test('invalid or unconfirmed labels and malformed descriptors cannot modify memory', async t => {
  const { memory, filename } = await fixture(t);
  for (const bad of [
    { confirmedSingleCharacter: false }, { confirmedSingleCharacter: undefined }, { confirmedSingleCharacter: 'true' },
    { englishName: '' }, { englishName: '知更鸟' }, { englishName: 'A'.repeat(33) }, { englishName: 'robin\nname' },
    { gameTags: ['a', 'b', 'c', 'd', 'e'] }, { characterTags: [''] }, { characterTags: ['x'.repeat(65)] },
    { mode: 'other' }, { fileId: '../outside' }, { sha256: 'bad-hash' },
    { descriptor: { ...descriptor(), version: 'unknown-version' } },
    { descriptor: { ...descriptor(), modelSha256: 'bad-model' } },
    { descriptor: { ...descriptor(), values: [1] } },
    { descriptor: { ...descriptor(), values: Array(1024).fill(0) } },
    { descriptor: { ...descriptor(), values: [2, ...Array(1023).fill(0)] } },
    { descriptor: { ...descriptor(), values: [NaN, ...Array(1023).fill(0)] } },
    { descriptor: { ...descriptor(), values: [Infinity, ...Array(1023).fill(0)] } },
  ]) await assert.rejects(memory.remember(reference(bad)), invalid);
  assert.deepEqual(await memory.list({ mode: 'live' }), []);
  await assert.rejects(fs.stat(filename), { code: 'ENOENT' });
  await assert.rejects(memory.match({ mode: 'live', sha256: hash(1), descriptor: { ...descriptor(), values: ['1', ...Array(1023).fill(0)] } }), invalid);
  assert.equal((await memory.remember(reference())).englishName, 'Robin');
});

test('forget removes all associated references persistently and unknown IDs are a harmless no-op', async t => {
  const { memory, dataDir } = await fixture(t);
  const saved = await memory.remember(reference());
  await memory.remember(reference({ sha256: hash(2), fileId: 'upload-2' }));
  assert.equal(await memory.forget({ mode: 'live', id: saved.id }), true);
  assert.equal(await memory.forget({ mode: 'live', id: saved.id }), false);
  const reopened = await createCharacterMemory({ dataDir });
  assert.deepEqual(await reopened.list({ mode: 'live' }), []);
  assert.deepEqual(await reopened.match({ mode: 'live', sha256: hash(1), descriptor: descriptor() }), { exact: null, candidates: [] });
});

test('concurrent mutations serialize and reads wait for preceding changes', async t => {
  const { memory, dataDir } = await fixture(t);
  const writes = [1, 2, 3].map(index => memory.remember(reference({ sha256: hash(index), fileId: `upload-${index}` })));
  const listed = memory.list({ mode: 'live' });
  await Promise.all(writes);
  assert.equal((await listed)[0].sampleCount, 3);
  assert.equal((await (await createCharacterMemory({ dataDir })).list({ mode: 'live' }))[0].sampleCount, 3);
});

test('reference limit permits duplicate confirmation but rejects new references without losing existing associations', async t => {
  const { memory } = await fixture(t);
  for (let index = 1; index <= 20; index++) await memory.remember(reference({ descriptor: null, sha256: hash(index), fileId: `upload-${index}` }));
  assert.equal((await memory.remember(reference({ descriptor: null }))).sampleCount, 20);
  const donor = await memory.remember(reference({ englishName: 'firefly', descriptor: null, sha256: hash(21), fileId: 'upload-21' }));
  await assert.rejects(memory.remember(reference({ descriptor: null, sha256: hash(21), fileId: 'upload-21' })), { code: 'CHARACTER_MEMORY_LIMIT', status: 409 });
  assert.equal((await memory.match({ mode: 'live', sha256: hash(21) })).exact.id, donor.id);
});

test('character limit rejects additions but still permits correcting the last reference of an existing identity', async t => {
  const { memory, filename, dataDir } = await fixture(t);
  await memory.remember(reference({ descriptor: null }));
  const document = JSON.parse(await fs.readFile(filename, 'utf8'));
  const template = document.modes.live[0];
  document.modes.live = Array.from({ length: 200 }, (_, index) => ({
    ...structuredClone(template),
    id: `${(index + 1).toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`,
    englishName: `Character ${index + 1}`,
    samples: [{ ...structuredClone(template.samples[0]), fileId: `upload-${index + 1}`, sha256: hash(index + 1) }],
  }));
  const saved = JSON.stringify(document);
  await fs.writeFile(filename, saved);
  const full = await createCharacterMemory({ dataDir });
  await assert.rejects(full.remember(reference({ sha256: hash(201), fileId: 'upload-201', descriptor: null })), { code: 'CHARACTER_MEMORY_LIMIT', status: 409 });
  assert.equal(await fs.readFile(filename, 'utf8'), saved);
  const corrected = await full.remember(reference({ descriptor: null }));
  assert.equal(corrected.englishName, 'Robin');
  assert.equal((await full.list({ mode: 'live' })).length, 200);
  assert.equal((await full.match({ mode: 'live', sha256: hash(1) })).exact.id, corrected.id);
});

test('corrupt JSON, conflicting hashes and malformed stored descriptors fail explicitly and preserve the file', async t => {
  const { memory, filename, dataDir } = await fixture(t);
  await memory.remember(reference());
  const original = await fs.readFile(filename, 'utf8');
  const duplicate = JSON.parse(original);
  duplicate.modes.live.push({ ...structuredClone(duplicate.modes.live[0]), id: '11111111-1111-4111-8111-111111111111', englishName: 'Mona' });
  const malformed = JSON.parse(original);
  malformed.modes.live[0].samples[0].descriptor.values[0] = 2;
  for (const contents of ['{not-json', '{}', JSON.stringify(duplicate), JSON.stringify(malformed)]) {
    await fs.writeFile(filename, contents);
    await assert.rejects(createCharacterMemory({ dataDir }), { code: 'CHARACTER_MEMORY_CORRUPT', status: 503 });
    assert.equal(await fs.readFile(filename, 'utf8'), contents);
  }
});

test('failed persistence does not commit partial in-memory state and the mutation queue recovers', async t => {
  const { dataDir } = await fixture(t);
  const nested = path.join(dataDir, 'blocked');
  const memory = await createCharacterMemory({ dataDir: nested });
  await fs.writeFile(nested, 'occupied by a file');
  await assert.rejects(memory.remember(reference()), { code: 'CHARACTER_MEMORY_WRITE_FAILED', status: 503 });
  assert.deepEqual(await memory.list({ mode: 'live' }), []);
  assert.equal(await fs.readFile(nested, 'utf8'), 'occupied by a file');
  await fs.unlink(nested);
  assert.equal((await memory.remember(reference())).sampleCount, 1);
});
