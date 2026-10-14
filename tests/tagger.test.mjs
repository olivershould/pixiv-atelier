import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createTagger, loadTagCatalog } from '../server/tagger.mjs';

// These tests deliberately use a protocol mock. They do not certify model inference.
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalogPath = path.join(projectRoot, 'server', 'tag-catalog.json');
const metadata = { model: 'protocol-test-model', modelVersion: 'test-revision', modelFiles: [
  { name: 'model.onnx', sha256: 'a'.repeat(64) }, { name: 'selected_tags.csv', sha256: 'b'.repeat(64) },
], manifestSha256: 'c'.repeat(64), sources: [{ title: 'Test fixture, not real model evidence', url: 'https://example.invalid/test-fixture' }] };
const digest = value => createHash('sha256').update(value).digest('hex');

async function fixture(t, handler, extra = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pixiv-tagger-test-'));
  const dataDir = path.join(root, '.data'), uploadDir = path.join(dataDir, 'uploads');
  const modelDir = path.join(dataDir, 'models', 'wd-swinv2-v3'), runtimeDir = path.join(root, '.runtime', 'tagger');
  const workerPath = path.join(root, 'worker.py');
  await Promise.all([fs.mkdir(uploadDir, { recursive: true }), fs.mkdir(modelDir, { recursive: true }), fs.mkdir(runtimeDir, { recursive: true }), fs.writeFile(workerPath, '# Protocol test fixture only\n')]);
  const requests = [], processes = [];
  function spawnProcess(command, args, options) {
    const proc = new EventEmitter();
    proc.stdout = new PassThrough(); proc.stderr = new PassThrough(); proc.killed = false;
    proc.stdin = new Writable({ write(chunk, encoding, done) {
      const request = JSON.parse(chunk.toString()); requests.push(request);
      Promise.resolve().then(async () => {
        let response;
        try {
          response = handler ? await handler(request) : request.op === 'health'
            ? { id: request.id, ok: true, ready: true, ...metadata }
            : { id: request.id, ok: true, ...metadata, analyzedFiles: request.files.map(({ id, sha256 }) => ({ id, sha256 })), predictions: [{ fileId: request.files[0].id, name: '1girl', category: 0, score: 0.94 }] };
        } catch (error) { response = { id: request.id, ok: false, error: error.message }; }
        if (response !== undefined && !proc.killed) proc.stdout.write(typeof response === 'string' ? response : `${JSON.stringify(response)}\n`);
      });
      done();
    } });
    proc.kill = () => { proc.killed = true; queueMicrotask(() => proc.emit('exit', 0)); return true; };
    processes.push({ proc, command, args, options });
    return proc;
  }
  const tagger = createTagger({ projectRoot: root, dataDir, uploadDir, modelDir, runtimeDir, workerPath, catalogPath, pythonPath: process.execPath, spawnProcess, ...extra });
  t.after(async () => { await tagger.close(); await fs.rm(root, { recursive: true, force: true }); });
  async function file(id, bytes = Buffer.from(`test image bytes ${id}`)) {
    const filePath = path.join(uploadDir, `${id}.png`); await fs.writeFile(filePath, bytes);
    return { id, path: filePath, sha256: digest(bytes) };
  }
  return { root, dataDir, uploadDir, modelDir, runtimeDir, workerPath, tagger, file, requests, processes, spawnProcess };
}

function health(request) { return { id: request.id, ok: true, ready: true, ...metadata }; }
function response(request, predictions) { return { id: request.id, ok: true, ...metadata, analyzedFiles: request.files.map(({ id, sha256 }) => ({ id, sha256 })), predictions }; }

test('public catalog contains static search mappings without private evidence or verification claims', async () => {
  const catalog = await loadTagCatalog();
  assert.equal(catalog.entries, 9);
  assert.equal(catalog.version, 'public-static-mapping.1');
  assert.deepEqual(catalog.evidence, []);
  assert.deepEqual([...catalog.names.keys()].sort(), [
    '1girl', '2girls', '3girls', '4girls', '5girls', '6+girls', 'multiple_girls',
    'barefoot', 'navel', 'smile', 'swimsuit', 'bare_shoulders',
    'barbara_(genshin_impact)', 'lumine_(genshin_impact)', 'kamisato_ayaka',
  ].sort());
  assert.equal(catalog.names.get('1girl').tag, '女の子');
  assert.match(catalog.names.get('1girl').note, /不推断成年或未成年/);
  assert.equal(catalog.names.get('kamisato_ayaka').tag, '神里綾華');
  assert.ok([...catalog.names.values()].every(entry => entry.verified === false && entry.evidence.length === 0));
});

test('mock worker health must complete before ready; one persistent process handles analysis', async t => {
  const f = await fixture(t);
  const result = await f.tagger.status();
  assert.equal(result.ready, true); assert.equal(result.catalogEntries, 9);
  assert.deepEqual(result.modelFiles, metadata.modelFiles);
  assert.equal(result.provenance.manifestSha256, metadata.manifestSha256);
  const file = await f.file('one');
  const analyzed = await f.tagger.analyze([file]);
  assert.equal(f.processes.length, 1);
  assert.equal(f.requests[0].op, 'health');
  assert.equal(analyzed.source, 'local'); assert.equal(analyzed.demo, false);
  assert.equal(analyzed.candidates[0].tag, '女の子');
  assert.deepEqual(analyzed.provenance.sources, metadata.sources);
  assert.deepEqual(analyzed.analyzedFiles, [{ id: file.id, sha256: file.sha256 }]);
  assert.equal(f.processes[0].options.windowsHide, true);
  assert.equal(f.processes[0].options.env.TAGGER_UPLOAD_DIR, f.uploadDir);
});

test('predictions use unverified search mappings; rating and below-threshold values are omitted', async t => {
  const f = await fixture(t, request => request.op === 'health' ? health(request) : response(request, [
    { fileId: request.files[0].id, name: '1girl', category: 0, score: .9 },
    { fileId: request.files[0].id, name: 'smile', category: 0, score: .75 },
    { fileId: request.files[0].id, name: 'blue_hair', category: 0, score: .8 },
    { fileId: request.files[0].id, name: 'test_character', category: 4, score: .95 },
    { fileId: request.files[0].id, name: 'explicit', category: 9, score: .99 },
    { fileId: request.files[0].id, name: 'safe', category: 0, score: .9 },
    { fileId: request.files[0].id, name: 'barefoot', category: 0, score: .1 },
  ]));
  const analyzed = await f.tagger.analyze([await f.file('one')]);
  assert.deepEqual(analyzed.candidates.map(item => item.tag), ['女の子', '笑顔']);
  assert.ok(analyzed.candidates.every(item => item.existing === false && item.verified === false && item.evidence.length === 0));
  assert.deepEqual(analyzed.unmapped.map(item => item.name), ['test_character', 'blue_hair']);
  assert.ok(analyzed.unmapped.every(item => item.existing === false && item.verified === false));
  assert.equal(analyzed.ratings, undefined); assert.equal(analyzed.rating, undefined); assert.equal(analyzed.aiGenerated, undefined);
});

test('audited category-4 character names map exactly without guessing other characters or games', async t => {
  const f = await fixture(t, request => request.op === 'health' ? health(request) : response(request, [
    { fileId: request.files[0].id, name: 'lumine_(genshin_impact)', category: 4, score: .96 },
    { fileId: request.files[0].id, name: 'barbara_(genshin_impact)', category: 4, score: .95 },
    { fileId: request.files[0].id, name: 'robin_(fire_emblem)', category: 4, score: .99 },
    { fileId: request.files[0].id, name: 'nico_robin', category: 4, score: .98 },
    { fileId: request.files[0].id, name: 'barbara', category: 4, score: .97 },
    { fileId: request.files[0].id, name: 'kamisato_ayaka', category: 4, score: .94 },
  ]));
  const analyzed = await f.tagger.analyze([await f.file('characters')]);
  assert.deepEqual(analyzed.candidates.map(item => item.tag), ['蛍(原神)', 'バーバラ(原神)', '神里綾華']);
  assert.deepEqual(analyzed.candidates.map(item => item.modelNames), [['lumine_(genshin_impact)'], ['barbara_(genshin_impact)'], ['kamisato_ayaka']]);
  assert.ok(analyzed.candidates.every(item => item.existing === false && item.verified === false && item.evidence.length === 0));
  assert.deepEqual(analyzed.unmapped.map(item => item.name), ['robin_(fire_emblem)', 'nico_robin', 'barbara']);
  assert.ok(analyzed.unmapped.every(item => item.existing === false && item.verified === false));
  assert.ok(!analyzed.candidates.some(item => ['原神', 'GenshinImpact', 'ロビン(スターレイル)'].includes(item.tag)));
});

test('multiple-girl aliases deduplicate without inferring age and bare shoulders uses its exact mapping', async t => {
  const f = await fixture(t, request => request.op === 'health' ? health(request) : response(request, [
    { fileId: request.files[0].id, name: '2girls', category: 0, score: .94 },
    { fileId: request.files[0].id, name: 'multiple_girls', category: 0, score: .91 },
    { fileId: request.files[0].id, name: 'bare_shoulders', category: 0, score: .84 },
  ]));
  const analyzed = await f.tagger.analyze([await f.file('multiple')]);
  assert.deepEqual(analyzed.candidates.map(item => item.tag), ['女の子', '肩出し']);
  assert.deepEqual(analyzed.candidates[0].modelNames, ['2girls', 'multiple_girls']);
  assert.equal(analyzed.candidates[0].confidence, .94);
  assert.match(analyzed.candidates[0].reason, /不推断成年或未成年/);
  assert.equal(analyzed.ageRestriction, undefined);
  assert.equal(analyzed.workAttributes, undefined);
  assert.equal(analyzed.unmapped.length, 0);
});

test('same image SHA produces the same fingerprint and is inferred once per analysis', async t => {
  const f = await fixture(t);
  const bytes = Buffer.from('identical bytes');
  const one = await f.file('one', bytes), two = await f.file('two', bytes);
  const combined = await f.tagger.analyze([one, two]);
  assert.equal(f.requests.filter(item => item.op === 'analyze').length, 1);
  assert.deepEqual(combined.candidates[0].fileIds, ['one', 'two']);
  const first = await f.tagger.analyze([one]), second = await f.tagger.analyze([two]);
  assert.equal(first.inputFingerprint, second.inputFingerprint);
  assert.notEqual(first.inputFingerprint, combined.inputFingerprint);
});

test('optional visual descriptors retain model provenance and remap duplicate image IDs without extra inference', async t => {
  const descriptor = { version: 'wd-swinv2-v3-pooled-v1', modelSha256: metadata.modelFiles[0].sha256, values: Array(1024).fill(1 / 32) };
  const f = await fixture(t, request => {
    if (request.op === 'health') return health(request);
    const result = response(request, [{ fileId: request.files[0].id, name: '1girl', category: 0, score: .94 }]);
    result.analyzedFiles[0].descriptor = descriptor;
    return result;
  });
  const bytes = Buffer.from('same descriptor image');
  const one = await f.file('one', bytes), two = await f.file('two', bytes);
  const result = await f.tagger.analyze([one, two]);
  assert.equal(f.requests.filter(request => request.op === 'analyze').length, 1);
  assert.deepEqual(result.analyzedFiles.map(file => file.id), ['one', 'two']);
  assert.deepEqual(result.analyzedFiles[0].descriptor, descriptor);
  assert.deepEqual(result.analyzedFiles[1].descriptor, descriptor);
  assert.notEqual(result.analyzedFiles[0].descriptor.values, result.analyzedFiles[1].descriptor.values);
  result.analyzedFiles[0].descriptor.values[0] = 0;
  assert.equal(result.analyzedFiles[1].descriptor.values[0], 1 / 32);
});

test('malformed optional descriptors are discarded without losing ordinary recognition', async t => {
  const valid = { version: 'wd-swinv2-v3-pooled-v1', modelSha256: metadata.modelFiles[0].sha256, values: Array(1024).fill(1 / 32) };
  const malformed = [
    null, [], { ...valid, version: 'unknown' }, { ...valid, modelSha256: '0'.repeat(64) }, { ...valid, modelSha256: [valid.modelSha256] },
    { ...valid, values: valid.values.slice(1) }, { ...valid, values: Array(1024).fill(0) },
    { ...valid, values: Array(1024).fill(1) }, { ...valid, values: [NaN, ...valid.values.slice(1)] },
    { ...valid, values: ['0.03125', ...valid.values.slice(1)] }, { ...valid, unexpected: true },
  ];
  for (const descriptor of malformed) {
    const f = await fixture(t, request => {
      if (request.op === 'health') return health(request);
      const result = response(request, [{ fileId: request.files[0].id, name: '1girl', category: 0, score: .94 }]);
      result.analyzedFiles[0].descriptor = descriptor;
      return result;
    });
    const result = await f.tagger.analyze([await f.file('one')]);
    assert.equal(result.analyzedFiles[0].descriptor, undefined);
    assert.equal(result.candidates[0].tag, '女の子');
    assert.ok(result.warnings.some(warning => warning.includes('角色记忆特征无效')));
    assert.equal(f.processes[0].proc.killed, false);
  }
});

test('absence of evidence produces unmapped concepts rather than guessed Pixiv tags', async t => {
  const f = await fixture(t, request => request.op === 'health' ? health(request) : response(request, [{ fileId: request.files[0].id, name: 'landscape', category: 0, score: .95 }]));
  const result = await f.tagger.analyze([await f.file('landscape')]);
  assert.equal(result.candidates.length, 0); assert.equal(result.unmapped[0].name, 'landscape');
  assert.ok(result.warnings.some(item => item.includes('没有匹配')));
});

test('invalid files, outside paths and changed hashes fail before model analysis', async t => {
  const f = await fixture(t), image = await f.file('one');
  const outside = path.join(f.root, 'outside.png'); await fs.writeFile(outside, 'outside');
  for (const files of [[], [image, image], [{ id: 'outside', path: outside }], [{ ...image, sha256: '0'.repeat(64) }], [{ id: 'relative', path: 'relative.png' }]]) {
    await assert.rejects(f.tagger.analyze(files), error => ['TAGGER_INVALID_FILES', 'TAGGER_HASH_MISMATCH'].includes(error.code));
  }
  assert.equal(f.requests.length, 0);
});

test('missing Python configuration is an unavailable capability, not an application startup error', async t => {
  const f = await fixture(t, undefined, { pythonPath: '' });
  const status = await f.tagger.status();
  assert.equal(status.ready, false); assert.equal(status.configured, false);
  assert.equal(status.code, 'TAGGER_NOT_CONFIGURED'); assert.equal(f.processes.length, 0);
});

test('mock worker cannot claim health without model source-file SHA metadata', async t => {
  const f = await fixture(t, request => ({ id: request.id, ok: true, ready: true, model: 'fake', modelVersion: '1' }));
  const result = await f.tagger.status();
  assert.equal(result.ready, false); assert.equal(result.code, 'TAGGER_PROTOCOL');
});

test('wrong response IDs, bad JSON, file hashes and invalid prediction values fail closed', async t => {
  const mutations = [
    request => ({ ...response(request, []), id: 'wrong-id' }),
    () => 'not JSON\n',
    request => ({ ...response(request, []), analyzedFiles: [{ id: request.files[0].id, sha256: '0'.repeat(64) }] }),
    request => response(request, [{ fileId: request.files[0].id, name: 'smile', category: 0, score: 1.2 }]),
    request => response(request, [{ fileId: 'another-file', name: 'smile', category: 0, score: .8 }]),
  ];
  for (const mutate of mutations) {
    const f = await fixture(t, request => request.op === 'health' ? health(request) : mutate(request));
    await assert.rejects(f.tagger.analyze([await f.file('one')]), error => error.code === 'TAGGER_PROTOCOL');
  }
});

test('a timed-out worker is killed and no partial or static fallback tags are returned', async t => {
  const f = await fixture(t, request => request.op === 'health' ? health(request) : undefined, { timeoutMs: 35 });
  await assert.rejects(f.tagger.analyze([await f.file('one')]), error => error.code === 'TAGGER_TIMEOUT');
  assert.equal(f.processes[0].proc.killed, true);
  assert.equal((await f.tagger.status()).ready, true);
  assert.equal(f.processes.length, 2);
});

test('worker exit invalidates cached readiness and a later health check rebuilds it', async t => {
  const f = await fixture(t);
  assert.equal((await f.tagger.status()).ready, true);
  f.processes[0].proc.emit('exit', 1);
  assert.equal((await f.tagger.status()).ready, true);
  assert.equal(f.processes.length, 2);
});

test('malformed prediction metadata clears readiness and restarts the worker', async t => {
  const f = await fixture(t, request => request.op === 'health' ? health(request) : { ...response(request, []), modelFiles: [] });
  await assert.rejects(f.tagger.analyze([await f.file('one')]), error => error.code === 'TAGGER_PROTOCOL');
  assert.equal(f.processes[0].proc.killed, true);
  assert.equal((await f.tagger.status()).ready, true);
  assert.equal(f.processes.length, 2);
});

test('legacy evidence catalogs remain supported and reject unsupported mappings', async t => {
  const f = await fixture(t);
  const legacyPath = path.join(f.root, 'legacy-catalog.json');
  const catalog = { schemaVersion: 1, version: 'synthetic-legacy-test', evidence: [{
    id: 'synthetic-source', kind: 'user_screenshot', image: 'synthetic-fixture.png', sha256: 'd'.repeat(64),
    observedAt: '2030-01-01', provenance: 'Synthetic protocol fixture; this is not a real screenshot.', verifiedTags: ['女の子'],
  }], entries: [{ id: 'girl', tag: '女の子', modelNames: ['1girl'], evidenceIds: ['synthetic-source'] }] };
  await fs.writeFile(legacyPath, JSON.stringify(catalog));
  const loaded = await loadTagCatalog(legacyPath);
  assert.equal(loaded.names.get('1girl').verified, true);
  assert.equal(loaded.names.get('1girl').evidence[0].sha256, 'd'.repeat(64));
  catalog.entries.push({ id: 'guessed', tag: 'not-observed', modelNames: ['landscape'], evidenceIds: ['synthetic-source'] });
  await fs.writeFile(legacyPath, JSON.stringify(catalog));
  await assert.rejects(loadTagCatalog(legacyPath), error => error.code === 'TAG_CATALOG_INVALID');
});

test('static catalog cannot claim screenshot evidence', async t => {
  const f = await fixture(t), invalidPath = path.join(f.root, 'invalid-static-catalog.json');
  const catalog = JSON.parse(await fs.readFile(catalogPath, 'utf8'));
  catalog.entries[0].evidenceIds = ['invented-proof'];
  await fs.writeFile(invalidPath, JSON.stringify(catalog));
  await assert.rejects(loadTagCatalog(invalidPath), error => error.code === 'TAG_CATALOG_INVALID');
});
