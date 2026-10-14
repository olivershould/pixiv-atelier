import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { createServer } from '../server/index.mjs';
import { createDemoState, blankState } from '../server/seed.mjs';
import { createCharacterMemory } from '../server/character-memory.mjs';

const NOW = '2026-10-04T10:00:00.000Z';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=', 'base64');
// The fixture's image bytes are fixed; store its correct IDAT checksum.
PNG.writeUInt32BE(4020414299, 52);
const unavailableTagger = () => ({
  status: async () => ({ configured: false, ready: false, model: 'test-unconfigured', catalogEntries: 0, error: '本地识图模型尚未设置。' }),
  analyze: async () => { throw new Error('未配置的模型不应执行识图。'); },
  close: async () => {},
});
async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
async function fixture(t, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pixiv-publisher-test-'));
  if (options.prepareData) await options.prepareData(dataDir);
  if (options.prepareState) {
    const envelope = { version: 1, mode: 'demo', states: { demo: createDemoState(NOW), live: blankState() }, uploads: {} };
    await options.prepareState(envelope);
    await fs.writeFile(path.join(dataDir, 'state.json'), JSON.stringify(envelope));
  }
  const server = await createServer({ dataDir, now: () => new Date(NOW), background: false, tagger: unavailableTagger(), ...options });
  const base = await listen(server);
  t.after(async () => {
    if (server.listening) await close(server);
    // mkdtemp produced this directory, and it remains strictly below the OS temp root.
    assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir()));
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  async function request(route, method = 'GET', payload, headers = {}) {
    const response = await fetch(`${base}${route}`, { method, headers: { ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: payload === undefined ? undefined : JSON.stringify(payload) });
    return { status: response.status, data: await response.json() };
  }
  return { server, base, request, dataDir };
}

function requestBodyQueued(server, pathname) {
  return new Promise(resolve => {
    const observed = req => {
      if (req.url !== pathname) return;
      server.off('request', observed);
      req.on('end', () => setImmediate(resolve));
    };
    server.on('request', observed);
  });
}
async function liveJob(f) {
  await f.request('/api/mode', 'POST', { mode: 'live' });
  let result = await f.request('/api/accounts', 'POST', { name: '实际创作账号', pixivUserId: '123456', connected: true, premium: true });
  const account = result.data.accounts[0];
  const response = await fetch(`${f.base}/api/files?name=painting.png`, { method: 'POST', body: PNG, headers: { 'Content-Type': 'image/png' } });
  assert.equal(response.status, 201);
  const { file } = await response.json();
  result = await f.request('/api/jobs', 'POST', { accountId: account.id, title: '测试作品', files: [file], tags: ['オリジナル'], tagsConfirmed: true, timezone: 'Asia/Shanghai', scheduledAt: '2026-10-05T12:00:00.000Z', status: 'queued', content: { aiGenerated: false, rating: 'all', sexualContent: false } });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.createdJobId, result.data.jobs[0].id);
  return { account, file, job: result.data.jobs[0] };
}

test('character memory requires explicit current-image confirmation and remains shared across accounts but isolated by mode', async t => {
  let analyses = 0;
  const descriptor = { version: 'wd-swinv2-v3-pooled-v1', modelSha256: 'b'.repeat(64), values: [1, ...Array(1023).fill(0)] };
  const tagger = { status: async () => ({ configured: true, ready: true }), close: async () => {},
    analyze: async files => { analyses++; return { source: 'local', candidates: [], predictions: [],
      analyzedFiles: await Promise.all(files.map(async file => ({ id: file.id, sha256: createHash('sha256').update(await fs.readFile(file.path)).digest('hex'), descriptor }))),
      recognition: { title: '', rating: 'all', sexualContent: false, characters: [], perFile: files.map(file => ({ fileId: file.id, single: true, multiple: false })) } }; } };
  const f = await fixture(t, { tagger });
  const { job } = await liveJob(f);
  await f.request(`/api/jobs/${job.id}`, 'PATCH', { title: 'Robin', status: 'draft' });
  assert.deepEqual((await f.request('/api/characters')).data.characters, [], 'ordinary titles never train memory');
  const analysis = await f.request('/api/tags/suggest', 'POST', { jobId: job.id, provider: 'local' });
  assert.equal(analysis.status, 200);
  assert.ok(analysis.data.memoryAnalysisId);
  assert.equal(analysis.data.analyzedFiles[0].descriptor, undefined, 'embeddings never leave server');
  const input = { mode: 'live', draft: job, analysisId: analysis.data.memoryAnalysisId, englishName: 'robin',
    gameTags: ['HonkaiStarRail'], characterTags: ['ロビン(スターレイル)'], confirmedSingleCharacter: true };
  assert.equal((await f.request('/api/characters/remember', 'POST', { ...input, confirmedSingleCharacter: false })).status, 400);
  assert.equal((await f.request('/api/characters/remember', 'POST', { ...input, analysisId: 'forged' })).status, 409);
  assert.equal((await f.request('/api/characters/remember', 'POST', { ...input, draft: { ...job, files: [...job.files, ...job.files] } })).status, 409);
  const remembered = await f.request('/api/characters/remember', 'POST', { ...input, sha256: 'f'.repeat(64), descriptor: { fake: true } });
  assert.equal(remembered.status, 200, JSON.stringify(remembered.data));
  assert.equal(remembered.data.character.englishName, 'Robin');
  assert.equal(analyses, 1, 'remembering uses cached server inference, no second analysis');
  assert.equal(remembered.data.character.samples[0].sha256, analysis.data.analyzedFiles[0].sha256, 'client hash/vector ignored');
  assert.ok(!JSON.stringify(remembered.data).includes('values'));
  const otherAccount = (await f.request('/api/accounts', 'POST', { name: 'Second', pixivUserId: '654321' })).data.accounts.at(-1);
  const repeatUpload = await fetch(`${f.base}/api/files?name=renamed.png`, { method: 'POST', body: PNG });
  const repeatFile = (await repeatUpload.json()).file;
  const recall = await f.request('/api/tags/suggest', 'POST', { provider: 'local', draft: { accountId: otherAccount.id, files: [repeatFile] } });
  assert.equal(recall.status, 200);
  assert.equal(recall.data.recognition.title, 'Robin', 'identical pixels/file renamed across accounts recall');
  assert.equal(recall.data.recognition.memory.exact.id, remembered.data.character.id);
  await f.request('/api/mode', 'POST', { mode: 'demo' });
  assert.deepEqual((await f.request('/api/characters')).data.characters, []);
  assert.equal((await f.request('/api/characters/remember', 'POST', input)).status, 409);
  assert.equal((await f.request(`/api/characters/${remembered.data.character.id}?mode=live`, 'DELETE')).status, 409);
  await f.request('/api/mode', 'POST', { mode: 'live' });
  const state = (await f.request('/api/state')).data;
  assert.equal(state.jobs.length, 1);
  assert.equal(state.jobs[0].title, 'Robin');
  assert.equal(state.jobs[0].status, 'draft');
  assert.equal((await f.request(`/api/characters/${remembered.data.character.id}?mode=live`, 'DELETE')).status, 200);
  assert.deepEqual((await f.request('/api/characters')).data.characters, []);
  const forget = await f.request('/api/tags/suggest', 'POST', { provider: 'local', jobId: job.id });
  assert.equal(forget.data.recognition.title, '');
});

test('bulk deletion removes local records atomically, preserves images and character memory, and survives restart', async t => {
  const f = await fixture(t);
  const { job, file } = await liveJob(f);
  const draft = (await f.request('/api/jobs', 'POST', { files: [file], title: 'Local draft' })).data.createdJobId;
  const cancelled = (await f.request('/api/jobs', 'POST', { files: [file], title: 'Cancelled draft' })).data.createdJobId;
  assert.equal((await f.request(`/api/jobs/${cancelled}`, 'DELETE')).status, 200);
  const retained = (await f.request('/api/jobs', 'POST', { files: [file], title: 'Keep me' })).data.createdJobId;
  const statePath = path.join(f.dataDir, 'state.json');
  const before = JSON.parse(await fs.readFile(statePath, 'utf8'));
  const memoryPath = path.join(f.dataDir, 'character-memory.json');
  const memoryBytes = JSON.stringify({ version: 1, modes: { demo: [], live: [{ id: '11111111-1111-4111-8111-111111111111', englishName: 'Robin', gameTags: ['HonkaiStarRail'], characterTags: [], updatedAt: NOW,
    samples: [{ fileId: file.id, sha256: createHash('sha256').update(PNG).digest('hex'), addedAt: NOW, descriptor: null }] }] } });
  await fs.writeFile(memoryPath, memoryBytes);
  const result = await f.request('/api/jobs/bulk-delete', 'POST', { mode: 'live', jobIds: [job.id, draft, cancelled] });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.deepEqual(result.data.deletedJobIds, [job.id, draft, cancelled]);
  assert.deepEqual(result.data.jobs.map(item => item.id), [retained]);
  assert.ok(result.data.jobs[0].canDeleteLocally);
  assert.equal(result.data.jobs[0].deleteBlockedReason, '');
  assert.ok(!result.data.queueReasons.some(reason => result.data.deletedJobIds.includes(reason.jobId)));
  const persisted = JSON.parse(await fs.readFile(statePath, 'utf8'));
  assert.deepEqual(persisted.states.live.jobs.map(item => item.id), [retained]);
  assert.equal(persisted.states.live.jobs[0].canDeleteLocally, undefined);
  assert.equal(persisted.states.live.jobs[0].deleteBlockedReason, undefined);
  assert.deepEqual(persisted.states.demo, before.states.demo);
  assert.deepEqual(persisted.states.live.accounts, before.states.live.accounts);
  assert.deepEqual(persisted.uploads, before.uploads);
  assert.deepEqual(persisted.states.live.logs.slice(1), before.states.live.logs);
  assert.match(persisted.states.live.logs[0].message, /删除 3 件/);
  assert.equal(await fs.readFile(memoryPath, 'utf8'), memoryBytes);
  const imageResponse = await fetch(`${f.base}${file.url}`);
  assert.equal(imageResponse.status, 200);
  assert.deepEqual(Buffer.from(await imageResponse.arrayBuffer()), PNG);
  await close(f.server);
  const second = await createServer({ dataDir: f.dataDir, background: false, tagger: unavailableTagger() });
  try {
    const base = await listen(second), state = await (await fetch(`${base}/api/state`)).json();
    assert.deepEqual(state.jobs.map(item => item.id), [retained]);
    assert.equal(state.jobs[0].canDeleteLocally, true);
    assert.equal((await (await fetch(`${base}/api/characters`)).json()).characters[0].englishName, 'Robin');
  } finally { await close(second); }
});

test('bulk deletion validates IDs and mode before any write, and a missing member rejects the complete batch', async t => {
  const f = await fixture(t);
  const statePath = path.join(f.dataDir, 'state.json'), before = await fs.readFile(statePath, 'utf8');
  const validId = 'demo-work-11';
  for (const payload of [
    { jobIds: [validId] }, { mode: 'invalid', jobIds: [validId] }, { mode: 'demo', jobIds: null },
    { mode: 'demo', jobIds: [] }, { mode: 'demo', jobIds: [123] }, { mode: 'demo', jobIds: [''] },
    { mode: 'demo', jobIds: ['x'.repeat(101)] }, { mode: 'demo', jobIds: Array(201).fill(validId) },
    { mode: 'demo', jobIds: [validId, validId] }, { mode: 'demo', jobIds: [validId, ` ${validId} `] },
  ]) assert.equal((await f.request('/api/jobs/bulk-delete', 'POST', payload)).status, 400);
  assert.equal((await f.request('/api/jobs/bulk-delete', 'POST', { mode: 'live', jobIds: [validId] })).status, 409);
  assert.equal((await f.request('/api/jobs/bulk-delete', 'POST', { mode: 'demo', jobIds: [validId, 'missing'] })).status, 404);
  assert.equal((await f.request('/api/jobs/bulk-delete', 'POST', { mode: 'demo', jobIds: [validId, 'demo-work-01'] })).status, 409);
  assert.equal(await fs.readFile(statePath, 'utf8'), before);
  assert.equal((await f.request('/api/state')).data.jobs.length, 30);
});

test('bulk deletion blocks remote and uncertain evidence even with stale local statuses', async t => {
  const variants = [
    ['local-draft', { status: 'draft' }, true], ['local-queued', { status: 'queued' }, true],
    ['local-cancelled', { status: 'cancelled' }, true],
    ['definite-failure', { status: 'failed', uploadOutcome: 'not_uploaded', uploadStartedAt: NOW, idempotencyKey: 'definite-key' }, true],
    ['uploading', { status: 'uploading' }, false], ['reserved', { status: 'reserved' }, false],
    ['published', { status: 'published' }, false], ['review', { status: 'needs_review', reviewReason: 'schedule_expired' }, false],
    ['unknown-status', { status: 'unknown' }, false], ['uncertain-failure', { status: 'failed' }, false],
    ['draft-remote-id', { status: 'draft', remoteId: 'remote-1' }, false],
    ['queued-artwork-id', { status: 'queued', artworkId: '1234' }, false],
    ['cancelled-published', { status: 'cancelled', publishedAt: NOW }, false],
    ['draft-artwork-url', { status: 'draft', artworkUrl: 'https://www.pixiv.net/artworks/1234' }, false],
    ['started', { status: 'queued', uploadStartedAt: NOW }, false],
    ['claimed', { status: 'queued', idempotencyKey: 'claim-key' }, false],
    ['uncertain-outcome', { status: 'draft', uploadOutcome: 'unknown' }, false],
    ['remote-failure', { status: 'failed', uploadOutcome: 'not_uploaded', remoteId: 'remote-failed' }, false],
    ['snapshot-job', { status: 'queued' }, false],
    ['snapshot-key', { status: 'failed', uploadOutcome: 'not_uploaded', idempotencyKey: 'remote-key' }, false],
    ['snapshot-generated-key', { status: 'queued', reservationAttempt: 2 }, false],
    ['snapshot-uncertain', { status: 'draft' }, false],
  ];
  const f = await fixture(t, { prepareState(envelope) {
    const state = envelope.states.demo, template = state.jobs[10];
    state.jobs = variants.map(([id, fields]) => ({ ...structuredClone(template), id, title: id, ...fields }));
    state.accounts[0].remote.reservations = [
      { status: 'failed', jobId: 'definite-failure', idempotencyKey: 'definite-key' },
      { status: 'reserved', jobId: 'snapshot-job', remoteId: 'snapshot-remote' },
      { status: 'published', idempotencyKey: 'remote-key', remoteId: 'snapshot-published' },
      { status: 'reserved', idempotencyKey: 'pixiv-reservation:demo-main:snapshot-generated-key:v2', remoteId: 'snapshot-generated' },
      { status: 'unknown', jobId: 'snapshot-uncertain' },
    ];
  } });
  const initial = (await f.request('/api/state')).data;
  for (const [id, , allowed] of variants) {
    const job = initial.jobs.find(item => item.id === id);
    assert.equal(job.canDeleteLocally, allowed, id);
    assert.equal(Boolean(job.deleteBlockedReason), !allowed, id);
    if (!allowed) {
      const response = await f.request('/api/jobs/bulk-delete', 'POST', { mode: 'demo', jobIds: ['local-draft', id] });
      assert.equal(response.status, 409, id);
      assert.equal(response.data.details.jobId, id);
    }
  }
  assert.equal((await f.request('/api/state')).data.jobs.length, variants.length);
  const allowedIds = variants.filter(([, , allowed]) => allowed).map(([id]) => id);
  const deleted = await f.request('/api/jobs/bulk-delete', 'POST', { mode: 'demo', jobIds: allowedIds });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.data.jobs.length, variants.length - allowedIds.length);
  assert.deepEqual(deleted.data.accounts, initial.accounts);
});

test('bulk deletion leaves all in-memory records intact if the atomic disk commit fails', async t => {
  const errors = [];
  t.mock.method(console, 'error', (...items) => errors.push(items));
  const f = await fixture(t), statePath = path.join(f.dataDir, 'state.json'), backupPath = path.join(f.dataDir, 'state-backup.json');
  const before = (await f.request('/api/state')).data;
  await fs.rename(statePath, backupPath);
  await fs.mkdir(statePath);
  let response;
  try {
    response = await f.request('/api/jobs/bulk-delete', 'POST', { mode: 'demo', jobIds: ['demo-work-11', 'demo-work-12'] });
    assert.equal(response.status, 500);
    assert.equal(errors.length, 1);
    const after = (await f.request('/api/state')).data;
    assert.deepEqual(after.jobs, before.jobs);
    assert.deepEqual(after.logs, before.logs);
    assert.equal(after.queueReasons, before.queueReasons);
    assert.ok(!(await fs.readdir(f.dataDir)).some(name => /^state\.json\..*\.tmp$/.test(name)));
  } finally {
    await fs.rmdir(statePath);
    await fs.rename(backupPath, statePath);
  }
  assert.equal((await f.request('/api/jobs/bulk-delete', 'POST', { mode: 'demo', jobIds: ['demo-work-11', 'demo-work-12'] })).status, 200);
});

test('a queued bulk deletion rechecks the workspace after preceding serialized operations', async t => {
  let started, release;
  const start = new Promise(resolve => { started = resolve; }), gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const f = await fixture(t, { browserConnector: { discover: async () => { started(); await gate; return { accounts: [] }; } } });
  const { job } = await liveJob(f);
  const blocker = f.request('/api/browser/discover', 'POST', {});
  await start;
  const modeQueued = requestBodyQueued(f.server, '/api/mode');
  const switchMode = f.request('/api/mode', 'POST', { mode: 'demo' });
  await modeQueued;
  const deletionQueued = requestBodyQueued(f.server, '/api/jobs/bulk-delete');
  const deletion = f.request('/api/jobs/bulk-delete', 'POST', { mode: 'live', jobIds: [job.id] });
  await deletionQueued;
  release();
  assert.equal((await blocker).status, 200);
  assert.equal((await switchMode).status, 200);
  assert.equal((await deletion).status, 409);
  assert.equal((await f.request('/api/mode', 'POST', { mode: 'live' })).data.jobs[0].id, job.id);
});

test('a bulk deletion waiting behind an upload rechecks the confirmed remote status', async t => {
  let started, release, record;
  const start = new Promise(resolve => { started = resolve; }), gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const adapter = http.createServer(async (req, res) => {
    const send = value => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.method === 'GET') return send({ ok: true, connected: true, premium: true, complete: true, total: record ? 1 : 0, reservations: record ? [record] : [] });
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString());
    started(); await gate;
    record = { remoteId: 'confirmed-remote', jobId: input.job.id, idempotencyKey: input.idempotencyKey, scheduledAt: input.job.scheduledAt, status: 'reserved' };
    send({ reservation: record });
  });
  const adapterUrl = await listen(adapter);
  t.after(() => close(adapter));
  const f = await fixture(t, { connectorUrl: adapterUrl });
  const { job } = await liveJob(f);
  assert.equal(job.canDeleteLocally, true);
  const upload = f.request('/api/queue/tick', 'POST', {});
  await start;
  const deletionQueued = requestBodyQueued(f.server, '/api/jobs/bulk-delete');
  const deletion = f.request('/api/jobs/bulk-delete', 'POST', { mode: 'live', jobIds: [job.id] });
  await deletionQueued;
  release();
  assert.equal((await upload).status, 200);
  assert.equal((await deletion).status, 409);
  const final = (await f.request('/api/state')).data;
  assert.equal(final.jobs.length, 1);
  assert.equal(final.jobs[0].status, 'reserved');
  assert.equal(final.jobs[0].remoteId, 'confirmed-remote');
  assert.equal(final.jobs[0].canDeleteLocally, false);
  assert.equal(final.accounts[0].remote.total, 1);
});

test('account posting-time settings persist, default drafts use the next Japan posting slot, invalid slots fail', async t=>{
 const f=await fixture(t);await f.request('/api/mode','POST',{mode:'live'});
 let r=await f.request('/api/accounts','POST',{name:'Example Beta',pixivUserId:'202',defaultPostingTime:'11:00'});
 const id=r.data.accounts[0].id;assert.equal(r.data.accounts[0].defaultPostingTime,'11:00');
 r=await f.request('/api/jobs','POST',{accountId:id});
 assert.equal(r.data.jobs[0].scheduledAt,'2026-10-05T02:00:00.000Z');
 assert.equal(r.data.jobs[0].timezone,'Asia/Tokyo');assert.equal(r.data.jobs[0].content.aiGenerated,true);
 assert.equal((await f.request(`/api/accounts/${id}`,'PATCH',{defaultPostingTime:'09:15'})).status,400);
 assert.equal((await f.request(`/api/accounts/${id}`,'PATCH',{defaultPostingTime:'24:00'})).status,400);
 await f.request(`/api/accounts/${id}`,'PATCH',{defaultPostingTime:'13:30'});
 const saved=JSON.parse(await fs.readFile(path.join(f.dataDir,'state.json'),'utf8'));
 assert.equal(saved.states.live.accounts[0].defaultPostingTime,'13:30');
 r=await f.request('/api/jobs','POST',{accountId:id});assert.equal(r.data.jobs.at(-1).scheduledAt,'2026-10-05T04:30:00.000Z');
});

test('new drafts use today before the default time and saved schedules remain unchanged', async t=>{
 let current='2026-10-12T17:00:00.000Z'; // October 13, 01:00 in Beijing.
 const f=await fixture(t,{now:()=>new Date(current)});await f.request('/api/mode','POST',{mode:'live'});
 let r=await f.request('/api/accounts','POST',{name:'Example Alpha',pixivUserId:'101'});
 const accountId=r.data.accounts[0].id;
 r=await f.request('/api/jobs','POST',{accountId});
 const jobId=r.data.createdJobId;
 assert.equal(r.data.jobs.find(j=>j.id===jobId).scheduledAt,'2026-10-13T00:00:00.000Z');
 current='2026-10-13T00:00:00.000Z'; // Exactly 09:00 JST: today's slot is no longer future.
 r=await f.request('/api/jobs','POST',{accountId});
 assert.equal(r.data.jobs.find(j=>j.id===r.data.createdJobId).scheduledAt,'2026-10-14T00:00:00.000Z');
 await f.request(`/api/accounts/${accountId}`,'PATCH',{defaultPostingTime:'11:00'});
 r=await f.request(`/api/jobs/${jobId}`,'PATCH',{title:'Keep this schedule'});
 assert.equal(r.status,200);assert.equal(r.data.jobs.find(j=>j.id===jobId).scheduledAt,'2026-10-13T00:00:00.000Z');
 r=await f.request('/api/jobs','POST',{accountId,scheduledAt:'2026-10-16T00:00:00.000Z'});
 assert.equal(r.data.jobs.find(j=>j.id===r.data.createdJobId).scheduledAt,'2026-10-16T00:00:00.000Z');
});

test('a multi-image work may retain an empty title through scheduling', async t=>{
 const f=await fixture(t);const {job}=await liveJob(f);
 const r=await f.request(`/api/jobs/${job.id}`,'PATCH',{title:'',files:[job.files[0],job.files[0]],tagsConfirmed:true,status:'queued'});
 assert.equal(r.status,200);assert.equal(r.data.jobs[0].title,'');assert.equal(r.data.jobs[0].files.length,2);
});

test('thirty demo jobs roll in confirmed groups of ten; repeated ticks do not duplicate', async t => {
  const f = await fixture(t);
  let { data: state } = await f.request('/api/state');
  assert.equal(state.mode, 'demo');
  assert.equal(state.jobs.length, 30);
  assert.equal(state.accounts.length, 3);
  assert.equal(state.jobs.filter(job => job.status === 'reserved').length, 10);
  for (let batch = 1; batch <= 3; batch++) {
    const response = await f.request('/api/demo/advance', 'POST', {});
    assert.equal(response.status, 200, JSON.stringify(response.data));
    state = response.data;
    assert.equal(state.jobs.filter(job => job.status === 'published').length, batch * 10);
    assert.equal(state.jobs.filter(job => job.status === 'reserved').length, batch < 3 ? 10 : 0);
    assert.equal(state.jobs.filter(job => job.status === 'queued').length, Math.max(0, 20 - batch * 10));
    assert.equal(new Set(state.accounts[0].remote.reservations.map(item => item.jobId)).size, state.accounts[0].remote.reservations.length);
    state = (await f.request('/api/queue/tick', 'POST', {})).data;
    assert.equal(state.jobs.filter(job => job.status === 'published').length, batch * 10);
  }
});

test('live data stays separate, accounts remain unconnected, and missing connector never fakes publication', async t => {
  const f = await fixture(t);
  const { account, job } = await liveJob(f);
  assert.equal(account.connected, false);
  assert.equal(account.premium, false);
  const result = await f.request('/api/queue/tick', 'POST', {});
  assert.equal(result.status, 503);
  assert.match(result.data.error, /连接器/);
  const tags = await f.request('/api/tags/suggest', 'POST', { jobId: job.id });
  assert.equal(tags.status, 503);
  await f.request('/api/mode', 'POST', { mode: 'demo' });
  await f.request('/api/demo/reset', 'POST', {});
  const { data } = await f.request('/api/mode', 'POST', { mode: 'live' });
  assert.equal(data.jobs.length, 1);
  assert.equal(data.jobs[0].id, job.id);
  assert.equal(data.jobs[0].status, 'queued');
  assert.equal(data.accounts.length, 1);
});

test('uploads inspect actual image bytes and protect local origin, host, and paths', async t => {
  const f = await fixture(t);
  let response = await fetch(`${f.base}/api/files?name=pretend.png`, { method: 'POST', body: '<svg><script>alert(1)</script></svg>', headers: { 'Content-Type': 'image/png' } });
  assert.equal(response.status, 415);
  response = await fetch(`${f.base}/api/files?name=real.png`, { method: 'POST', body: PNG });
  assert.equal(response.status, 201);
  const { file } = await response.json();
  response = await fetch(`${f.base}${file.url}`);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG);
  assert.equal((await f.request('/api/state', 'GET', undefined, { Origin: 'https://evil.example' })).status, 403);
  const badHostStatus = await new Promise((resolve, reject) => {
    http.get(`${f.base}/api/state`, { headers: { Host: 'evil.example' } }, reply => { reply.resume(); resolve(reply.statusCode); }).on('error', reject);
  });
  assert.equal(badHostStatus, 403);
  assert.equal((await f.request('/api/state', 'GET', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  response = await fetch(`${f.base}/..%5Cserver%5Cindex.mjs`);
  assert.equal(response.status, 400);
  response = await fetch(`${f.base}/api/accounts`, { method: 'POST', body: 'name=test', headers: { 'Content-Type': 'text/plain' } });
  assert.equal(response.status, 415);
});

test('only static GIF is accepted, and draft saves enforce 200 images and total 200 MiB', async t => {
  const f = await fixture(t);
  const gif = Buffer.from('47494638396101000100800000ffffff0000002c00000000010001000002024401003b', 'hex');
  let response = await fetch(`${f.base}/api/files?name=static.gif`, { method: 'POST', body: gif });
  assert.equal(response.status, 201);
  const animated = Buffer.concat([gif.subarray(0, -1), gif.subarray(19)]);
  response = await fetch(`${f.base}/api/files?name=animated.gif`, { method: 'POST', body: animated });
  assert.equal(response.status, 415);
  assert.match((await response.json()).error, /静态 GIF/);
  const invalidPng = Buffer.from(PNG); invalidPng[45] ^= 1;
  response = await fetch(`${f.base}/api/files?name=invalid.png`, { method: 'POST', body: invalidPng });
  assert.equal(response.status, 415);
  // A valid ignorable PNG ancillary chunk creates a realistic 1 MiB fixture.
  const chunk = Buffer.alloc(1024 * 1024 + 12);
  chunk.writeUInt32BE(1024 * 1024, 0); chunk.write('npAd', 4, 'ascii');
  let checksum = 0xffffffff;
  for (const byte of chunk.subarray(4, -4)) {
    checksum ^= byte;
    for (let bit = 0; bit < 8; bit++) checksum = (checksum >>> 1) ^ ((checksum & 1) ? 0xedb88320 : 0);
  }
  chunk.writeUInt32BE((checksum ^ 0xffffffff) >>> 0, chunk.length - 4);
  const largePng = Buffer.concat([PNG.subarray(0, -12), chunk, PNG.subarray(-12)]);
  response = await fetch(`${f.base}/api/files?name=large.png`, { method: 'POST', body: largePng });
  assert.equal(response.status, 201);
  const { file } = await response.json();
  let saved = await f.request('/api/jobs', 'POST', { title: '容量检查', status: 'draft', files: Array(199).fill(file) });
  assert.equal(saved.status, 200);
  saved = await f.request('/api/jobs', 'POST', { title: '超过总大小', status: 'draft', files: Array(200).fill(file) });
  assert.equal(saved.status, 400);
  assert.match(saved.data.error, /总大小/);
  saved = await f.request('/api/jobs', 'POST', { title: '超过张数', status: 'draft', files: Array(201).fill(file) });
  assert.equal(saved.status, 400);
  assert.match(saved.data.error, /200 张/);
});

test('drafts can be incomplete; confirmed tags reset on edits and remote jobs cannot be edited or cancelled', async t => {
  const f = await fixture(t);
  let response = await f.request('/api/jobs', 'POST', { title: '未完成草稿' });
  assert.equal(response.status, 200);
  const draft = response.data.jobs.at(-1);
  assert.equal(response.data.createdJobId, draft.id);
  assert.equal(draft.content.aiGenerated, true);
  assert.equal(draft.content.rating, null);
  assert.equal(draft.content.sexualContent, null);
  assert.equal(draft.content.allowCollection, true);
  assert.deepEqual(draft.content.adultAttributes, []);
  response = await f.request(`/api/jobs/${draft.id}`, 'PATCH', { content: { allowCollection: false } });
  assert.equal(response.data.jobs.at(-1).content.allowCollection, false);
  assert.equal((await f.request(`/api/jobs/${draft.id}`, 'PATCH', { content: { allowCollection: 'yes' } })).status, 400);
  response = await f.request(`/api/jobs/${draft.id}`, 'PATCH', { content: { rating: 'r18', adultAttributes: ['bl', 'gl'], sexualContent: null } });
  assert.deepEqual(response.data.jobs.at(-1).content.adultAttributes, ['bl', 'gl']);
  assert.equal((await f.request(`/api/jobs/${draft.id}`, 'PATCH', { content: { adultAttributes: ['unknown'] } })).status, 400);
  response = await f.request(`/api/jobs/${draft.id}`, 'PATCH', { content: { rating: 'all' } });
  assert.deepEqual(response.data.jobs.at(-1).content.adultAttributes, []);
  response = await f.request(`/api/jobs/${draft.id}`, 'PATCH', { status: 'queued' });
  assert.equal(response.status, 400);
  response = await f.request('/api/jobs/demo-work-11', 'PATCH', { tags: ['新标签'] });
  assert.equal(response.status, 422);
  response = await f.request('/api/jobs/demo-work-11', 'PATCH', { status: 'draft', tags: ['新标签'] });
  assert.equal(response.status, 200);
  assert.equal(response.data.jobs.find(job => job.id === 'demo-work-11').tagsConfirmed, false);
  assert.equal((await f.request('/api/jobs/demo-work-01', 'PATCH', { title: '不可改' })).status, 409);
  assert.equal((await f.request('/api/jobs/demo-work-01', 'DELETE')).status, 409);
  assert.equal((await f.request('/api/accounts/demo-main', 'DELETE')).status, 409);
  response = await f.request('/api/jobs/demo-work-11', 'DELETE');
  assert.equal(response.status, 200);
  assert.equal(response.data.jobs.find(job => job.id === 'demo-work-11').status, 'cancelled');
});

test('serialized writes persist together and survive a server restart', async t => {
  const f = await fixture(t);
  await f.request('/api/mode', 'POST', { mode: 'live' });
  const results = await Promise.all(Array.from({ length: 12 }, (_, index) => f.request('/api/accounts', 'POST', { name: `账号 ${index}`, pixivUserId: `${1000 + index}` })));
  assert.ok(results.every(result => result.status === 200));
  await close(f.server);
  const second = await createServer({ dataDir: f.dataDir, background: false });
  const base = await listen(second);
  try {
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.mode, 'live');
    assert.equal(state.accounts.length, 12);
    assert.equal(new Set(state.accounts.map(account => account.id)).size, 12);
    assert.equal(state.jobs.length, 0);
  } finally { await close(second); }
});

test('connector evidence confirms reservations, filters tag candidates, and uncertain uploads cannot retry blindly', async t => {
  const records = new Map();
  let uploads = 0, failUpload = false, booleanEvidenceOnly = false, connectorTagCalls = 0;
  const adapter = http.createServer(async (req, res) => {
    const send = (status, payload) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); };
    if (req.headers.authorization !== 'Bearer test-token') return send(401, {});
    const accountId = req.url.split('/')[2];
    if (req.method === 'GET') return send(200, { ok: true, connected: true, premium: true, complete: true, total: (records.get(accountId) ?? []).length, reservations: records.get(accountId) ?? [] });
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString());
    if (req.url === '/tags/suggest') {
      connectorTagCalls++;
      assert.equal(payload.files[0].base64, PNG.toString('base64'));
      return send(200, { candidates: [
        { tag: '想像しただけ', existing: false, verified: false },
        { tag: '布尔标记不能替代证据', existing: true, verified: true },
        { tag: 'オリジナル', existing: true, verified: true, confidence: 0.92,
          evidence: booleanEvidenceOnly ? [] : [{ kind: 'pixiv_tag_page', tag: 'オリジナル', url: 'https://www.pixiv.net/tags/%E3%82%AA%E3%83%AA%E3%82%B8%E3%83%8A%E3%83%AB/artworks', checkedAt: NOW }] },
      ] });
    }
    uploads++;
    if (failUpload) return send(503, { error: 'unknown outcome' });
    const reservation = { remoteId: `remote-${uploads}`, jobId: payload.job.id, idempotencyKey: payload.idempotencyKey, scheduledAt: payload.job.scheduledAt, status: 'reserved' };
    records.set(accountId, [...(records.get(accountId) ?? []), reservation]);
    send(200, { reservation });
  });
  const adapterUrl = await listen(adapter);
  t.after(() => close(adapter));
  const f = await fixture(t, { connectorUrl: adapterUrl, connectorToken: 'test-token' });
  const first = await liveJob(f);
  let response = await f.request('/api/tags/suggest', 'POST', { jobId: first.job.id });
  assert.equal(response.status, 503);
  assert.equal(connectorTagCalls, 0, 'Local model failure must never silently fall back to the Pixiv connector.');
  response = await f.request('/api/tags/suggest', 'POST', { jobId: first.job.id, provider: 'connector' });
  assert.equal(response.status, 200);
  assert.equal(response.data.candidates.length, 1);
  assert.equal(response.data.candidates[0].tag, 'オリジナル');
  assert.equal(response.data.candidates[0].evidence[0].kind, 'pixiv_tag_page');
  assert.equal(response.data.candidates[0].sourceUrl, response.data.candidates[0].evidence[0].url);
  response = await f.request('/api/tags/suggest', 'POST', { provider: 'connector', draft: { ...first.job, title: '未保存的表单修改', status: 'draft' } });
  assert.equal(response.status, 200);
  assert.equal(response.data.candidates[0].tag, 'オリジナル');
  const afterDraftAnalysis = (await f.request('/api/state')).data;
  assert.equal(afterDraftAnalysis.jobs.length, 1);
  assert.equal(afterDraftAnalysis.jobs[0].status, 'queued');
  assert.equal(afterDraftAnalysis.jobs[0].title, first.job.title);
  booleanEvidenceOnly = true;
  assert.equal((await f.request('/api/tags/suggest', 'POST', { jobId: first.job.id, provider: 'connector' })).status, 502);
  booleanEvidenceOnly = false;
  response = await f.request('/api/queue/tick', 'POST', {});
  assert.equal(response.data.jobs[0].status, 'reserved');
  assert.equal(response.data.accounts[0].connected, true);
  assert.equal(uploads, 1);
  await f.request('/api/queue/tick', 'POST', {});
  assert.equal(uploads, 1);
  const second = await f.request('/api/jobs', 'POST', { ...first.job, id: undefined, status: 'queued', title: '需要核对的作品' });
  assert.equal(second.status, 200);
  failUpload = true;
  response = await f.request('/api/queue/tick', 'POST', {});
  assert.equal(response.data.jobs.at(-1).status, 'needs_review');
  assert.equal(uploads, 2);
  await f.request('/api/queue/tick', 'POST', {});
  assert.equal(uploads, 2);
});

test('unconnected or non-Premium accounts cannot upload; definitive not-uploaded outcomes can be explicitly retried with a new key', async t => {
  let connected = false, premium = true, uploadCount = 0;
  const history = [];
  const adapter = http.createServer(async (req, res) => {
    const send = payload => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); };
    if (req.method === 'GET') return send({ ok: true, connected, premium, complete: true, total: history.filter(item => item.status === 'reserved').length, reservations: history });
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString());
    uploadCount++;
    if (uploadCount === 1) {
      history.push({ jobId: payload.job.id, idempotencyKey: payload.idempotencyKey, status: 'failed' });
      return send({ definitive: true, outcome: 'not_uploaded', error: '测试：连接器在上传前明确拒绝。' });
    }
    const reservation = { remoteId: `retry-${uploadCount}`, jobId: payload.job.id, idempotencyKey: payload.idempotencyKey, status: 'reserved', scheduledAt: payload.job.scheduledAt };
    history.push(reservation);
    return send({ reservation });
  });
  const adapterUrl = await listen(adapter);
  t.after(() => close(adapter));
  const f = await fixture(t, { connectorUrl: adapterUrl });
  const { job } = await liveJob(f);
  let response = await f.request('/api/queue/tick', 'POST', {});
  assert.equal(response.data.jobs[0].status, 'queued');
  assert.equal(uploadCount, 0);
  connected = true; premium = false;
  await f.request('/api/queue/tick', 'POST', {});
  assert.equal(uploadCount, 0);
  premium = true;
  response = await f.request('/api/queue/tick', 'POST', {});
  assert.equal(response.data.jobs[0].status, 'failed');
  assert.equal(response.data.jobs[0].uploadOutcome, 'not_uploaded');
  const oldKey = response.data.jobs[0].idempotencyKey;
  response = await f.request(`/api/jobs/${job.id}`, 'PATCH', { status: 'queued' });
  assert.equal(response.status, 200);
  assert.equal(response.data.jobs[0].reservationAttempt, 2);
  assert.equal(response.data.jobs[0].idempotencyKey, undefined);
  response = await f.request('/api/queue/tick', 'POST', {});
  assert.equal(response.data.jobs[0].status, 'reserved');
  assert.equal(uploadCount, 2);
  assert.notEqual(response.data.jobs[0].idempotencyKey, oldKey);
  assert.match(response.data.jobs[0].idempotencyKey, /:v2$/);
  assert.equal((await f.request(`/api/jobs/${job.id}`, 'PATCH', { status: 'queued' })).status, 409);
});

for (const scenario of ['unknown-outcome', 'external-slot-increase']) {
  test(`each upload rechecks current account state: ${scenario} stops the remaining batch while another account proceeds`, async t => {
    const records = new Map(), calls = new Map();
    let primaryAccountId;
    const adapter = http.createServer(async (req, res) => {
      const accountId = req.url.split('/')[2];
      const send = (status, payload) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); };
      if (req.method === 'GET') return send(200, { ok: true, connected: true, premium: true, complete: true, total: (records.get(accountId) ?? []).length, reservations: records.get(accountId) ?? [] });
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks).toString());
      calls.set(accountId, (calls.get(accountId) ?? 0) + 1);
      if (accountId === primaryAccountId && scenario === 'unknown-outcome') return send(503, { error: 'the remote outcome is unknown' });
      const reservation = { remoteId: `remote-${payload.job.id}`, jobId: payload.job.id, idempotencyKey: payload.idempotencyKey, scheduledAt: payload.job.scheduledAt, status: 'reserved' };
      const external = accountId === primaryAccountId && scenario === 'external-slot-increase'
        ? Array.from({ length: 9 }, (_, index) => ({ remoteId: `outside-app-${index}`, scheduledAt: payload.job.scheduledAt, status: 'reserved' })) : [];
      records.set(accountId, [...(records.get(accountId) ?? []), reservation, ...external]);
      return send(200, { reservation });
    });
    const adapterUrl = await listen(adapter);
    t.after(() => close(adapter));
    const f = await fixture(t, { connectorUrl: adapterUrl });
    const { account, job } = await liveJob(f);
    primaryAccountId = account.id;
    for (let index = 0; index < 2; index++) assert.equal((await f.request('/api/jobs', 'POST', { ...job, title: `同账号排队 ${index}` })).status, 200);
    const accountResponse = await f.request('/api/accounts', 'POST', { name: '独立账号', pixivUserId: '987654' });
    const otherAccount = accountResponse.data.accounts.at(-1);
    assert.equal((await f.request('/api/jobs', 'POST', { ...job, accountId: otherAccount.id, title: '其它账号作品' })).status, 200);
    const response = await f.request('/api/queue/tick', 'POST', {});
    assert.equal(response.status, 200);
    assert.equal(calls.get(primaryAccountId), 1);
    assert.equal(calls.get(otherAccount.id), 1);
    const primaryJobs = response.data.jobs.filter(item => item.accountId === primaryAccountId);
    assert.equal(primaryJobs.filter(item => item.status === 'queued').length, 2);
    assert.equal(primaryJobs.filter(item => item.status === (scenario === 'unknown-outcome' ? 'needs_review' : 'reserved')).length, 1);
    assert.equal(response.data.jobs.find(item => item.accountId === otherAccount.id).status, 'reserved');
    const primaryRemote = response.data.accounts.find(item => item.id === primaryAccountId).remote;
    if (scenario === 'unknown-outcome') assert.equal(primaryRemote.syncOk, false);
    else assert.equal(primaryRemote.total, 10);
  });
}

test('local inference does not require Pixiv, runs outside the mutation queue, and marks changed requests stale', async t => {
  let startedResolve, finishResolve, analyzedFiles;
  const started = new Promise(resolve => { startedResolve = resolve; });
  const inferenceGate = new Promise(resolve => { finishResolve = resolve; });
  t.after(() => finishResolve());
  const tagger = {
    status: async () => ({ configured: true, ready: true, model: 'test-local-model', modelVersion: 'test-version', catalogEntries: 5 }),
    analyze: async files => {
      analyzedFiles = files;
      startedResolve();
      await inferenceGate;
      return { source: 'local', demo: false, inputFingerprint: 'test-image-content-fingerprint', analyzedFiles: files.map(file => ({ id: file.id })),
        candidates: [{ tag: 'オリジナル', confidence: 0.81, existing: true, verified: true,
          evidence: [{ kind: 'user_screenshot', image: 'test-evidence.png', observedAt: '2026-10-04' }] }] };
    },
    close: async () => {},
  };
  const f = await fixture(t, { tagger });
  const { job } = await liveJob(f);
  const health = await f.request('/api/tagger/status');
  assert.equal(health.data.available, true);
  assert.equal(health.data.catalogEntries, 5);
  assert.equal((await f.request('/api/state')).data.connectorConfigured, false);
  const pending = f.request('/api/tags/suggest', 'POST', { jobId: job.id });
  await started;
  let timeout;
  const guard = new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Inference blocked the global mutation queue.')), 1500); });
  try {
    const update = await Promise.race([f.request(`/api/jobs/${job.id}`, 'PATCH', { status: 'draft', title: '用户在识别期间修改的标题' }), guard]);
    assert.equal(update.status, 200);
    assert.equal((await f.request('/api/settings', 'PATCH', { queuePaused: true })).status, 200);
    assert.equal((await f.request('/api/mode', 'POST', { mode: 'demo' })).status, 200);
  } finally { clearTimeout(timeout); finishResolve(); }
  const response = await pending;
  assert.equal(response.status, 200);
  assert.equal(response.data.source, 'local');
  assert.equal(response.data.provider, 'local');
  assert.equal(response.data.mode, 'live');
  assert.equal(response.data.stale, true);
  assert.equal(response.data.modeChanged, true);
  assert.equal(response.data.sourceChanged, true);
  assert.match(response.data.requestFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(response.data.inputFingerprint, 'test-image-content-fingerprint');
  assert.equal(analyzedFiles.length, 1);
  assert.equal(analyzedFiles[0].base64, undefined);
  assert.deepEqual(await fs.readFile(analyzedFiles[0].path), PNG);
  const state = (await f.request('/api/mode', 'POST', { mode: 'live' })).data;
  assert.equal(state.jobs.length, 1);
  assert.equal(state.jobs[0].title, '用户在识别期间修改的标题');
  assert.deepEqual(state.jobs[0].tags, ['オリジナル']);
});

test('demo examples are distinct from explicitly chosen local inference and cannot masquerade as real images', async t => {
  let analyzed = 0;
  const tagger = {
    status: async () => ({ configured: true, ready: true, model: 'test-local-model', catalogEntries: 5 }),
    analyze: async () => { analyzed++; return { source: 'local', demo: false, candidates: [], warnings: ['No supported catalog match.'], inputFingerprint: 'pixels' }; },
    close: async () => {},
  };
  const f = await fixture(t, { tagger });
  let response = await f.request('/api/tags/suggest', 'POST', { jobId: 'demo-work-01' });
  assert.equal(response.data.provider, 'demo');
  assert.equal(response.data.source, 'demo');
  assert.equal(analyzed, 0);
  response = await f.request('/api/tags/suggest', 'POST', { provider: 'local', jobId: 'demo-work-01' });
  assert.equal(response.status, 422);
  assert.match(response.data.error, /演示封面不能用于真实识图/);
  const uploaded = await fetch(`${f.base}/api/files?name=uploaded.png`, { method: 'POST', body: PNG });
  const { file } = await uploaded.json();
  response = await f.request('/api/tags/suggest', 'POST', { provider: 'local', draft: { accountId: 'demo-main', files: [file] } });
  assert.equal(response.status, 200);
  assert.equal(response.data.source, 'local');
  assert.equal(response.data.mode, 'demo');
  assert.equal(response.data.demo, false);
  assert.deepEqual(response.data.candidates, []);
  assert.equal(analyzed, 1);
  await f.request('/api/mode', 'POST', { mode: 'live' });
  assert.equal((await fetch(`${f.base}${file.url}`)).status, 404, 'Images from the demo space must not be served in the live space.');
  assert.equal((await f.request('/api/tags/suggest', 'POST', { provider: 'demo', draft: { files: [] } })).status, 409);
  assert.equal((await f.request('/api/tags/suggest', 'POST', { provider: 'local', draft: { files: [file] } })).status, 400);
});

test('upload analysis returns ordered automatic tags using the selected account history without changing saved work', async t => {
  let analyzed = 0, searched = 0;
  const tagger = {
    status: async () => ({configured:true,ready:true,model:'fixture',catalogEntries:1}),
    analyze: async files => { analyzed++; return {
      source:'local', candidates:[],
      predictions:[{name:'mona_(genshin_impact)',category:4,score:.99,fileId:files[0].id},{name:'navel',category:0,score:.9,fileId:files[0].id}],
      recognition:{title:'Mona',rating:'r18',characters:[{name:'mona_(genshin_impact)',confidence:.99}],sexualContent:null},
      warnings:[],
    }; },
    close: async () => {},
  };
  const browserConnector = {
    bind: async account => ({account:{...account,browser:{targetId:'A'.repeat(32),postingEnabled:false}},snapshot:emptyPixivSnapshot()}),
    searchTags: async (account, words, options) => {
      searched++; assert.equal(account.pixivUserId,'123456'); assert.equal(options.includeHistory,true);
      assert.ok(words.includes('R-18')); assert.ok(words.includes('原神')); assert.ok(words.includes('モナ(原神)'));
      return {pixivUserId:account.pixivUserId,checkedAt:NOW,frequentTags:['おへそ','原神','モナ(原神)','R-18'],
        recentWorks:[{artworkId:'100',title:'Mona',tags:['原神','R-18','モナ(原神)','おへそ']}],
        matches:words.filter(word=>['おへそ','原神','モナ(原神)','R-18'].includes(word)).map(word=>({word,tag:word,url:'https://www.pixiv.net/tags/'+encodeURIComponent(word)+'/artworks'}))};
    },
  };
  const f=await fixture(t,{tagger,browserConnector}), {account,job}=await liveJob(f);
  await f.request(`/api/accounts/${account.id}/browser`,'POST',{candidateId:'candidate'});
  const response=await f.request('/api/tags/suggest','POST',{provider:'local',jobId:job.id});
  assert.equal(response.status,200,JSON.stringify(response.data));
  assert.deepEqual(response.data.automaticTags,['原神','R-18','モナ(原神)','おへそ']);
  assert.deepEqual(response.data.candidates.map(c=>c.tagRole),['game','rating','character','scene']);
  assert.equal(response.data.recognition.title,'Mona');
  assert.equal(response.data.tagSearch.recentWorks[0].artworkId,'100');
  assert.equal(analyzed,1); assert.equal(searched,1);
  const saved=(await f.request('/api/state')).data;
  assert.deepEqual(saved.jobs[0].tags,['オリジナル']); assert.equal(saved.accounts[0].browser.postingEnabled,false);
});

test('failed site matching still auto-selects only evidenced, relevant local tags', async t => {
  const tagger={
    status:async()=>({configured:true,ready:true,model:'fixture',catalogEntries:1}),
    analyze:async files=>({source:'local',recognition:{title:'',rating:'all',characters:[]},
      predictions:[{name:'navel',category:0,score:.93,fileId:files[0].id}],
      candidates:[{tag:'おへそ',modelScore:.93,confidence:.93,modelNames:['navel'],fileIds:[files[0].id],existing:true,verified:true,evidence:[{kind:'user_screenshot',image:'source.png',observedAt:'2026-10-04'}]}]}),
    close:async()=>{},
  };
  const browserConnector={
    bind:async account=>({account:{...account,browser:{targetId:'A'.repeat(32),postingEnabled:false}},snapshot:emptyPixivSnapshot()}),
    searchTags:async()=>{throw new Error('Chrome 连接暂不可用');},
  };
  const f=await fixture(t,{tagger,browserConnector}),{account,job}=await liveJob(f);
  await f.request(`/api/accounts/${account.id}/browser`,'POST',{candidateId:'candidate'});
  const response=await f.request('/api/tags/suggest','POST',{provider:'local',jobId:job.id});
  assert.equal(response.status,200,JSON.stringify(response.data));
  assert.deepEqual(response.data.automaticTags,['おへそ']);
  assert.ok(response.data.warnings.some(w=>w.includes('全站匹配未完成')));
  assert.equal(response.data.candidates[0].tagRole,'scene');
  assert.equal(response.data.candidates[0].evidence[0].kind,'user_screenshot');
});

test('common tag pool APIs read cache without Chrome, persist pins/removals, and isolate account bindings', async t => {
  let searches = 0;
  const browserConnector = {
    bind: async account => ({ account: { ...account, browser: { targetId: account.id, postingEnabled: false } }, snapshot: emptyPixivSnapshot() }),
    searchTags: async (account, words, options) => {
      searches++; assert.deepEqual(words, []); assert.equal(options.includeHistory, true);
      return { pixivUserId: account.pixivUserId, checkedAt: NOW, frequentTags: ['原神', '女の子'], recentWorks: [{ artworkId: '42', title: 'Mona', tags: ['原神', 'おへそ'] }], matches: [] };
    },
  };
  const f = await fixture(t, { browserConnector });
  await f.request('/api/mode', 'POST', { mode: 'live' });
  const account = (await f.request('/api/accounts', 'POST', { name: 'First', pixivUserId: '123456' })).data.accounts[0];
  const route = `/api/tags/pool?accountId=${account.id}&mode=live`;
  assert.deepEqual((await f.request(route)).data.tags, []);
  assert.equal(searches, 0);
  assert.equal((await f.request('/api/tags/pool', 'POST', { mode: 'live', accountId: account.id, addTags: ['Ｍｏｎａ', 'mona'] })).status, 200);
  assert.equal(searches, 0, 'manual pool controls never connect Chrome');
  await f.request(`/api/accounts/${account.id}/browser`, 'POST', { candidateId: 'candidate' });
  let response = await f.request('/api/tags/pool/sync', 'POST', { mode: 'live', accountId: account.id });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.deepEqual(response.data.tags, ['Mona', '原神', '女の子', 'おへそ']);
  assert.equal(response.data.cached, false);
  assert.equal(searches, 1);
  await f.request('/api/tags/pool', 'POST', { mode: 'live', accountId: account.id, removeTags: ['原神'] });
  response = await f.request('/api/tags/pool/sync', 'POST', { mode: 'live', accountId: account.id });
  assert.deepEqual(response.data.tags, ['Mona', '女の子', 'おへそ']);
  assert.equal((await f.request(route)).data.cached, true);
  assert.equal(searches, 2, 'GET does not recheck remote tags');
  assert.equal((await f.request('/api/tags/pool', 'POST', { mode: 'demo', accountId: account.id, addTags: ['WrongMode'] })).status, 409);
  const second = (await f.request('/api/accounts', 'POST', { name: 'Second', pixivUserId: '654321' })).data.accounts.at(-1);
  assert.deepEqual((await f.request(`/api/tags/pool?accountId=${second.id}&mode=live`)).data.tags, []);
  await f.request(`/api/accounts/${account.id}`, 'PATCH', { pixivUserId: '111111' });
  assert.deepEqual((await f.request(route)).data.tags, [], 'new Pixiv ID cannot inherit a previous binding');
  await f.request(`/api/accounts/${account.id}`, 'PATCH', { pixivUserId: '123456' });
  assert.deepEqual((await f.request(route)).data.tags, ['Mona', '女の子', 'おへそ']);
  await close(f.server);
  const restarted = await createServer({ dataDir: f.dataDir, background: false, now: () => new Date(NOW), tagger: unavailableTagger(), browserConnector });
  const restartBase = await listen(restarted);
  try { assert.deepEqual((await (await fetch(restartBase + route)).json()).tags, ['Mona', '女の子', 'おへそ']); }
  finally { await close(restarted); }
});

test('explicit full history sync forwards bounded pagination and returns saved progress without modifying jobs', async t => {
  const optionsSeen = [];
  const browserConnector = {
    bind: async account => ({ account: { ...account, browser: { targetId: account.id, postingEnabled: false } }, snapshot: emptyPixivSnapshot() }),
    searchTags: async (account, words, options) => {
      optionsSeen.push(options);
      return { pixivUserId: account.pixivUserId, checkedAt: NOW, frequentTags: ['原神'], matches: [],
        recentWorks: [{ artworkId: '42', title: 'Mona', tags: ['原神', 'モナ(原神)'] }],
        historyScan: { total: 21, offset: 20, nextOffset: 21, attempted: 1, succeeded: 1, failed: 0, remaining: 0, complete: true, truncated: false } };
    },
  };
  const f = await fixture(t, { browserConnector });
  await f.request('/api/mode', 'POST', { mode: 'live' });
  const account = (await f.request('/api/accounts', 'POST', { name: 'History', pixivUserId: '123456' })).data.accounts[0];
  await f.request(`/api/accounts/${account.id}/browser`, 'POST', { candidateId: 'candidate' });
  const jobs = (await f.request('/api/state')).data.jobs;
  const result = await f.request('/api/tags/pool/sync', 'POST', { mode: 'live', accountId: account.id, fullHistory: true, historyOffset: 20, historyLimit: 100 });
  assert.equal(result.status, 200);
  assert.deepEqual(optionsSeen, [{ includeHistory: true, fullHistory: true, historyOffset: 20, historyLimit: 100, historyTimeBudgetMs: 120000 }]);
  assert.equal(result.data.historyScan.nextOffset, 21); assert.equal(result.data.historyCount, 1);
  assert.deepEqual((await f.request('/api/state')).data.jobs, jobs);
  assert.equal((await f.request('/api/tags/pool/sync', 'POST', { mode: 'live', accountId: account.id, fullHistory: true, historyLimit: 2001 })).status, 400);
  assert.equal(optionsSeen.length, 1);
});

test('late tag pool sync never writes after a mode round-trip, rebinding, or account removal', async t => {
  for (const change of ['mode', 'identity', 'delete']) await t.test(change, async sub => {
    let release, started;
    const gate = new Promise(resolve => { release = resolve; }), began = new Promise(resolve => { started = resolve; });
    const browserConnector = {
      bind: async account => ({ account: { ...account, browser: { targetId: account.id, postingEnabled: false } }, snapshot: emptyPixivSnapshot() }),
      searchTags: async account => { started(); await gate; return { pixivUserId: account.pixivUserId, checkedAt: NOW, frequentTags: ['LateTag'], recentWorks: [], matches: [] }; },
    };
    const f = await fixture(sub, { browserConnector });
    await f.request('/api/mode', 'POST', { mode: 'live' });
    const account = (await f.request('/api/accounts', 'POST', { name: 'First', pixivUserId: '123456' })).data.accounts[0];
    await f.request(`/api/accounts/${account.id}/browser`, 'POST', { candidateId: 'candidate' });
    const pending = f.request('/api/tags/pool/sync', 'POST', { mode: 'live', accountId: account.id });
    await began;
    if (change === 'mode') { await f.request('/api/mode', 'POST', { mode: 'demo' }); await f.request('/api/mode', 'POST', { mode: 'live' }); }
    else if (change === 'identity') await f.request(`/api/accounts/${account.id}`, 'PATCH', { pixivUserId: '999999' });
    else await f.request(`/api/accounts/${account.id}`, 'DELETE', {});
    release();
    assert.equal((await pending).status, 409);
    await assert.rejects(fs.access(path.join(f.dataDir, 'tag-pools.json')), { code: 'ENOENT' });
  });
});

test('cached tag evidence survives remote failure without verifying manual additions and honors removals during recognition', async t => {
  let blocked = false, rejectSearch, started;
  const began = new Promise(resolve => { started = resolve; });
  let initial = true;
  const browserConnector = {
    bind: async account => ({ account: { ...account, browser: { targetId: account.id, postingEnabled: false } }, snapshot: emptyPixivSnapshot() }),
    searchTags: async (account, words) => {
      if (initial) { assert.deepEqual(words, []); initial = false; return { pixivUserId: account.pixivUserId, checkedAt: NOW, frequentTags: ['おへそ'], recentWorks: [], matches: [] }; }
      if (blocked) { started(); await new Promise((_, reject) => { rejectSearch = reject; }); }
      throw new Error('offline');
    },
  };
  const tagger = {
    status: async () => ({ configured: true, ready: true }), close: async () => {},
    analyze: async files => ({ source: 'local', recognition: { title: '', rating: 'all', characters: [] }, candidates: [],
      predictions: [{ name: 'navel', category: 0, score: .95, fileId: files[0].id }, { name: 'hat', category: 0, score: .95, fileId: files[0].id }] }),
  };
  const f = await fixture(t, { browserConnector, tagger }), { account, job } = await liveJob(f);
  await f.request(`/api/accounts/${account.id}/browser`, 'POST', { candidateId: 'candidate' });
  assert.equal((await f.request('/api/tags/pool/sync', 'POST', { mode: 'live', accountId: account.id })).status, 200);
  await f.request('/api/tags/pool', 'POST', { mode: 'live', accountId: account.id, addTags: ['Hat'] });
  let response = await f.request('/api/tags/suggest', 'POST', { provider: 'local', jobId: job.id });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.deepEqual(response.data.automaticTags, ['おへそ']);
  assert.ok(!response.data.candidates.some(candidate => candidate.tag === 'Hat'), 'unverified pins never invent Pixiv existence');
  assert.equal(response.data.tagSearch.source, 'pixiv-cache');
  assert.equal(response.data.candidates[0].evidence[0].checkedAt, NOW);
  assert.equal(response.data.candidates[0].evidence[0].kind, 'pixiv_tag_cache');
  blocked = true;
  const pending = f.request('/api/tags/suggest', 'POST', { provider: 'local', jobId: job.id });
  await began;
  await f.request('/api/tags/pool', 'POST', { mode: 'live', accountId: account.id, removeTags: ['おへそ'] });
  rejectSearch(new Error('offline'));
  response = await pending;
  assert.deepEqual(response.data.automaticTags, [], 'late fallback respects the current pool');
  assert.deepEqual(response.data.tagPool.tags, ['Hat']);
  assert.equal(response.data.candidates[0].preferred, false);
  assert.deepEqual((await f.request('/api/state')).data.jobs[0].tags, ['オリジナル']);
});

test('manual preferences constrain local fallback without requiring any browser connection', async t => {
  const tagger = {
    status: async () => ({ configured: true, ready: true }), close: async () => {},
    analyze: async files => ({ source: 'local', recognition: { title: '', rating: 'all', characters: [] },
      predictions: [{ name: 'navel', category: 0, score: .95, fileId: files[0].id }],
      candidates: [{ tag: 'おへそ', confidence: .95, modelScore: .95, modelNames: ['navel'], fileIds: [files[0].id], existing: true, verified: true, evidence: [{ kind: 'user_screenshot', image: 'fixture.png' }] }] }),
  };
  const f = await fixture(t, { tagger }), { account, job } = await liveJob(f);
  await f.request('/api/tags/pool', 'POST', { mode: 'live', accountId: account.id, addTags: ['女の子'] });
  const response = await f.request('/api/tags/suggest', 'POST', { provider: 'local', jobId: job.id });
  assert.equal(response.status, 200);
  assert.deepEqual(response.data.automaticTags, []);
  assert.equal(response.data.candidates[0].accountPreferenceContext, true);
  assert.equal(response.data.candidates[0].preferred, false);
});

test('manual character names resolve from shared confirmed memory without Chrome or image analysis', async t => {
  let searches = 0, allowSearch = true;
  const browserConnector = {
    bind: async account => ({ account: { ...account, browser: { targetId: account.id, postingEnabled: false } }, snapshot: emptyPixivSnapshot() }),
    searchTags: async (account, words) => {
      searches++; assert.equal(allowSearch, true, 'cached resolution must not access Chrome'); assert.deepEqual(words, []);
      return { pixivUserId: account.pixivUserId, checkedAt: NOW, frequentTags: ['崩壊:スターレイル', 'ロビン(スターレイル)'],
        recentWorks: [{ artworkId: '42', title: 'Robin', tags: ['崩壊:スターレイル', 'ロビン(スターレイル)'] }], matches: [] };
    },
  };
  const f = await fixture(t, { browserConnector, prepareData: async dataDir => {
    const memory = await createCharacterMemory({ dataDir });
    await memory.remember({ mode: 'live', englishName: 'Robin', gameTags: ['崩壊:スターレイル'], characterTags: ['ロビン(スターレイル)'], fileId: 'sample-one', sha256: 'a'.repeat(64), confirmedSingleCharacter: true });
  } });
  await f.request('/api/mode', 'POST', { mode: 'live' });
  const first = (await f.request('/api/accounts', 'POST', { name: 'First', pixivUserId: '123456' })).data.accounts[0];
  const second = (await f.request('/api/accounts', 'POST', { name: 'Second', pixivUserId: '654321' })).data.accounts[1];
  const beforeAnySync = await f.request('/api/characters/resolve', 'POST', { mode: 'live', accountId: first.id, name: 'Robin' });
  assert.equal(beforeAnySync.data.status, 'resolved');
  assert.equal(beforeAnySync.data.source, 'account-style-template');
  assert.equal(beforeAnySync.data.identitySource, 'user-memory');
  assert.equal(searches, 0);
  for (const account of [first, second]) {
    await f.request(`/api/accounts/${account.id}/browser`, 'POST', { candidateId: 'candidate' });
    assert.equal((await f.request('/api/tags/pool/sync', 'POST', { mode: 'live', accountId: account.id })).status, 200);
  }
  const priorCharacters = (await f.request('/api/characters')).data;
  const priorJobs = (await f.request('/api/state')).data.jobs;
  allowSearch = false;
  for (const account of [first, second]) {
    const response = await f.request('/api/characters/resolve', 'POST', { mode: 'live', accountId: account.id, name: 'Robin' });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    assert.equal(response.data.status, 'resolved');
    assert.equal(response.data.name, 'Robin');
    assert.equal(response.data.accountId, account.id);
    assert.equal(response.data.pixivUserId, account.pixivUserId);
    assert.deepEqual(response.data.gameTags, ['崩壊:スターレイル']);
    assert.deepEqual(response.data.characterTags, ['ロビン(スターレイル)']);
    assert.deepEqual(response.data.tags, ['崩壊:スターレイル', 'ロビン(スターレイル)']);
    assert.equal(response.data.source, 'pixiv-history-template', 'account history takes precedence once available');
  }
  assert.equal(searches, 2, 'only the two explicit pool syncs read Chrome');
  assert.deepEqual((await f.request('/api/characters')).data, priorCharacters);
  assert.deepEqual((await f.request('/api/state')).data.jobs, priorJobs);
});

test('manual names resolve from verified account history cache without a character-memory record or reconnecting Chrome', async t => {
  let searches = 0;
  const browserConnector = {
    bind: async account => ({ account: { ...account, browser: { targetId: account.id, postingEnabled: false } }, snapshot: emptyPixivSnapshot() }),
    searchTags: async (account, words) => {
      searches++; assert.deepEqual(words, [], 'only the explicit initial sync reaches Chrome');
      return { pixivUserId: account.pixivUserId, checkedAt: NOW, frequentTags: ['崩壊:スターレイル', 'ロビン(スターレイル)'],
        recentWorks: [{ artworkId: '42', title: 'Robin', tags: ['崩壊:スターレイル', 'ロビン(スターレイル)'] }], matches: [] };
    },
  };
  const f = await fixture(t, { browserConnector });
  await f.request('/api/mode', 'POST', { mode: 'live' });
  const account = (await f.request('/api/accounts', 'POST', { name: 'First', pixivUserId: '123456' })).data.accounts[0];
  await f.request(`/api/accounts/${account.id}/browser`, 'POST', { candidateId: 'candidate' });
  await f.request('/api/tags/pool/sync', 'POST', { mode: 'live', accountId: account.id });
  const response = await f.request('/api/characters/resolve', 'POST', { mode: 'live', accountId: account.id, name: 'Robin' });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.equal(response.data.status, 'resolved');
  assert.equal(response.data.source, 'pixiv-history-template');
  assert.deepEqual(response.data.tags, ['崩壊:スターレイル', 'ロビン(スターレイル)']);
  assert.ok(response.data.evidence.every(item => item.checkedAt === NOW && item.cached));
  assert.equal(searches, 1);
  assert.deepEqual((await f.request('/api/characters')).data.characters, []);
});

test('manual character resolution rejects ambiguous/multiple names and does not invent proof from manual tags', async t => {
  let searches = 0;
  const f = await fixture(t, { browserConnector: {
    bind: async account => ({ account: { ...account, browser: { targetId: account.id, postingEnabled: false } }, snapshot: emptyPixivSnapshot() }),
    searchTags: async () => { searches++; throw new Error('unexpected query'); },
  }, prepareData: async dataDir => {
    const memory = await createCharacterMemory({ dataDir });
    await memory.remember({ mode: 'live', englishName: 'Robin', gameTags: ['崩壊:スターレイル'], characterTags: ['ロビン(スターレイル)'], fileId: 'sample-one', sha256: 'a'.repeat(64), confirmedSingleCharacter: true });
    await memory.remember({ mode: 'live', englishName: 'Robin', gameTags: ['ファイアーエムブレム'], characterTags: ['ルフレ'], fileId: 'sample-two', sha256: 'b'.repeat(64), confirmedSingleCharacter: true });
  } });
  await f.request('/api/mode', 'POST', { mode: 'live' });
  const account = (await f.request('/api/accounts', 'POST', { name: 'First', pixivUserId: '123456' })).data.accounts[0];
  await f.request('/api/tags/pool', 'POST', { mode: 'live', accountId: account.id, addTags: ['原神', 'モナ(原神)'] });
  const input = { mode: 'live', accountId: account.id };
  const manual = await f.request('/api/characters/resolve', 'POST', { ...input, name: 'Mona' });
  assert.equal(manual.status, 200);
  assert.equal(manual.data.status, 'not-found');
  assert.deepEqual(manual.data.tags, []);
  await f.request(`/api/accounts/${account.id}/browser`, 'POST', { candidateId: 'candidate' });
  const ambiguous = await f.request('/api/characters/resolve', 'POST', { ...input, name: 'Robin' });
  assert.equal(ambiguous.data.status, 'ambiguous');
  assert.deepEqual(ambiguous.data.tags, []);
  const unknown = await f.request('/api/characters/resolve', 'POST', { ...input, name: 'UnknownUnregisteredHero' });
  assert.equal(unknown.data.status, 'not-found');
  assert.equal(searches, 0);
  for (const name of ['', 'a'.repeat(65), 'Mona,Robin', 'Mona and Robin', 'Mona\n', '莫娜、刻晴']) {
    assert.equal((await f.request('/api/characters/resolve', 'POST', { ...input, name })).status, 400);
  }
  assert.equal((await f.request('/api/characters/resolve', 'POST', { ...input, mode: 'demo', name: 'Mona' })).status, 409);
});

test('manual character lookup uses exact live proof only when needed, with no history refresh or image-memory writes', async t => {
  let searches = 0;
  const browserConnector = {
    bind: async account => ({ account: { ...account, browser: { targetId: account.id, postingEnabled: false } }, snapshot: emptyPixivSnapshot() }),
    searchTags: async (account, words, options) => {
      searches++; assert.equal(options.includeHistory, false);
      assert.ok(words.includes('原神')); assert.ok(words.includes('モナ(原神)'));
      return { pixivUserId: account.pixivUserId, checkedAt: NOW, frequentTags: ['原神', 'モナ(原神)'],
        matches: words.filter(word => ['原神', 'モナ(原神)'].includes(word)).map(word => ({ word, tag: word, url: `https://www.pixiv.net/tags/${encodeURIComponent(word)}/artworks` })) };
    },
  };
  const f = await fixture(t, { browserConnector });
  await f.request('/api/mode', 'POST', { mode: 'live' });
  const account = (await f.request('/api/accounts', 'POST', { name: 'First', pixivUserId: '123456' })).data.accounts[0];
  await f.request(`/api/accounts/${account.id}/browser`, 'POST', { candidateId: 'candidate' });
  const response = await f.request('/api/characters/resolve', 'POST', { mode: 'live', accountId: account.id, name: 'Mona' });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.equal(response.data.status, 'resolved');
  assert.deepEqual(response.data.tags, ['原神', 'モナ(原神)']);
  assert.equal(response.data.source, 'pixiv');
  assert.equal(searches, 1);
  assert.deepEqual((await f.request('/api/characters')).data.characters, []);
  assert.deepEqual((await f.request('/api/state')).data.jobs, []);
  await assert.rejects(fs.access(path.join(f.dataDir, 'tag-pools.json')), { code: 'ENOENT' });
});

test('manual character lookup discards a delayed result after account rebinding', async t => {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; }), began = new Promise(resolve => { started = resolve; });
  const browserConnector = {
    bind: async account => ({ account: { ...account, browser: { targetId: account.id, postingEnabled: false } }, snapshot: emptyPixivSnapshot() }),
    searchTags: async (account, words) => { started(); await gate; return { pixivUserId: account.pixivUserId, checkedAt: NOW, frequentTags: [],
      matches: words.filter(word => ['原神', 'モナ(原神)'].includes(word)).map(word => ({ word, tag: word, url: 'https://www.pixiv.net/illustration/create' })) }; },
  };
  const f = await fixture(t, { browserConnector });
  await f.request('/api/mode', 'POST', { mode: 'live' });
  const account = (await f.request('/api/accounts', 'POST', { name: 'First', pixivUserId: '123456' })).data.accounts[0];
  await f.request(`/api/accounts/${account.id}/browser`, 'POST', { candidateId: 'candidate' });
  const pending = f.request('/api/characters/resolve', 'POST', { mode: 'live', accountId: account.id, name: 'Mona' });
  await began;
  assert.equal((await f.request(`/api/accounts/${account.id}`, 'PATCH', { pixivUserId: '987654' })).status, 200);
  release();
  assert.equal((await pending).status, 409);
  assert.deepEqual((await f.request('/api/state')).data.jobs, []);
  assert.deepEqual((await f.request('/api/characters')).data.characters, []);
});

test('slow model health cannot delay HTTP startup or state mutations, and its startup promise remains tracked', async t => {
  let release, checks = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const tagger = {
    status: async () => { checks++; await gate; return { configured: true, ready: true, model: 'cold-model', catalogEntries: 5 }; },
    analyze: async () => { throw new Error('not used'); },
    close: async () => { release(); },
  };
  let timeout;
  const guard = new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('HTTP startup waited for model initialization.')), 1500); });
  let f;
  try { f = await Promise.race([fixture(t, { tagger }), guard]); }
  finally { clearTimeout(timeout); }
  try {
    assert.ok(f.server.taggerStatusReady instanceof Promise);
    assert.equal((await f.request('/api/health')).status, 200);
    assert.equal((await f.request('/api/state')).data.tagger.status, 'checking');
    const pendingHealth = f.request('/api/tagger/status');
    const setting = await f.request('/api/settings', 'PATCH', { queuePaused: true });
    assert.equal(setting.status, 200);
    assert.equal(setting.data.settings.queuePaused, true);
    assert.equal(checks, 1, 'Overlapping health requests share the pending startup check.');
    release();
    assert.equal((await pendingHealth).data.available, true);
    assert.equal((await f.server.taggerStatusReady).model, 'cold-model');
  } finally { release(); }
});

test('an incomplete thumbnail page can be saved in a draft but cannot enter the reservation queue', async t => {
  const f = await fixture(t);
  const { job } = await liveJob(f);
  let response = await f.request(`/api/jobs/${job.id}`, 'PATCH', { status: 'draft', content: { thumbnail: { page: 200, x: 0.5, y: 0.5 } } });
  assert.equal(response.status, 200);
  assert.equal(response.data.jobs[0].content.thumbnail.page, 200);
  response = await f.request(`/api/jobs/${job.id}`, 'PATCH', { status: 'queued' });
  assert.equal(response.status, 422);
  assert.ok(response.data.details.some(issue => issue.field === 'content.thumbnail.page'));
  assert.equal((await f.request('/api/state')).data.jobs[0].status, 'draft');
  response = await f.request(`/api/jobs/${job.id}`, 'PATCH', { status: 'queued', content: { thumbnail: { page: 1, x: 0.5, y: 0.5 } } });
  assert.equal(response.status, 200);
  assert.equal(response.data.jobs[0].status, 'queued');
});

for (const delay of ['initial-sync', 'between-uploads']) {
  test(`a slow ${delay} cannot submit a job whose schedule has already passed`, async t => {
    let current = NOW, uploads = 0;
    const reservations = [];
    const adapter = http.createServer(async (req, res) => {
      const send = payload => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); };
      if (req.method === 'GET') {
        if (delay === 'initial-sync' || uploads > 0) current = '2026-10-05T12:01:00.000Z';
        return send({ ok: true, connected: true, premium: true, total: reservations.length, complete: true, reservations });
      }
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks).toString());
      uploads++;
      const reservation = { remoteId: `remote-${uploads}`, jobId: payload.job.id, idempotencyKey: payload.idempotencyKey, scheduledAt: payload.job.scheduledAt, status: 'reserved' };
      reservations.push(reservation);
      send({ reservation });
    });
    const adapterUrl = await listen(adapter);
    t.after(() => close(adapter));
    const f = await fixture(t, { connectorUrl: adapterUrl, now: () => new Date(current) });
    const { job } = await liveJob(f);
    assert.equal((await f.request('/api/jobs', 'POST', { ...job, title: '随后提交的作品' })).status, 200);
    const response = await f.request('/api/queue/tick', 'POST', {});
    assert.equal(response.status, 200);
    assert.equal(uploads, delay === 'initial-sync' ? 0 : 1);
    assert.equal(response.data.jobs.filter(item => item.reviewReason === 'schedule_expired').length, delay === 'initial-sync' ? 2 : 1);
    assert.equal(response.data.accounts[0].remote.syncedAt, current);
  });
}

test('the final pre-submit check cancels an expired local claim after file preparation without calling the connector', async t => {
  let f, elapsed = false, uploads = 0;
  const adapter = http.createServer(async (req, res) => {
    if (req.method === 'POST') uploads++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, connected: true, premium: true, total: 0, complete: true, reservations: [] }));
  });
  const adapterUrl = await listen(adapter);
  t.after(() => close(adapter));
  f = await fixture(t, { connectorUrl: adapterUrl, now: () => {
    if (f && !elapsed) {
      const saved = JSON.parse(readFileSync(path.join(f.dataDir, 'state.json'), 'utf8'));
      elapsed = saved.states.live.jobs.some(item => item.status === 'uploading');
    }
    return new Date(elapsed ? '2026-10-05T12:01:00.000Z' : NOW);
  } });
  const { job } = await liveJob(f);
  const response = await f.request('/api/queue/tick', 'POST', {});
  assert.equal(response.status, 200);
  assert.equal(uploads, 0);
  assert.equal(response.data.jobs[0].status, 'needs_review');
  assert.equal(response.data.jobs[0].reviewReason, 'schedule_expired');
  assert.equal(response.data.jobs[0].uploadStartedAt, undefined);
  assert.equal(response.data.jobs[0].remoteId, undefined);
  assert.equal((await f.request(`/api/jobs/${job.id}`, 'PATCH', { status: 'queued', scheduledAt: '2026-10-06T12:00:00.000Z' })).status, 200);
});

for (const problem of ['missing', 'different']) {
  test(`a ${problem} remote reservation time remains uncertain and is never uploaded again`, async t => {
    let reservation, uploads = 0, corrected = false, expectedTime;
    const adapter = http.createServer(async (req, res) => {
      const send = payload => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); };
      if (req.method === 'GET') return send({ ok: true, connected: true, premium: true, complete: true, total: reservation ? 1 : 0,
        reservations: reservation ? [{ ...reservation, ...(corrected ? { scheduledAt: expectedTime } : {}) }] : [] });
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks).toString());
      uploads++; expectedTime = payload.job.scheduledAt;
      reservation = { remoteId: 'actual-remote', jobId: payload.job.id, idempotencyKey: payload.idempotencyKey, status: 'reserved',
        ...(problem === 'different' ? { scheduledAt: '2026-10-05T13:00:00.000Z' } : {}) };
      send({ reservation });
    });
    const adapterUrl = await listen(adapter);
    t.after(() => close(adapter));
    const f = await fixture(t, { connectorUrl: adapterUrl });
    const { job } = await liveJob(f);
    let response = await f.request('/api/queue/tick', 'POST', {});
    assert.equal(response.data.jobs[0].status, 'needs_review');
    assert.equal(response.data.jobs[0].reviewReason, problem === 'missing' ? 'reservation_time_missing' : 'reservation_time_mismatch');
    assert.equal(response.data.jobs[0].remoteId, 'actual-remote');
    assert.equal(uploads, 1);
    await f.request('/api/queue/tick', 'POST', {});
    assert.equal(uploads, 1);
    assert.equal((await f.request(`/api/jobs/${job.id}`, 'PATCH', { status: 'queued' })).status, 409);
    corrected = true;
    response = await f.request('/api/queue/tick', 'POST', {});
    assert.equal(response.data.jobs[0].status, 'reserved');
    assert.equal(response.data.jobs[0].remoteScheduledAt, expectedTime);
    assert.equal(uploads, 1, 'A corrected read-back resolves the existing reservation instead of resubmitting it.');
  });
}

test('built-in browser binding preserves account settings and requires a separate posting switch', async t => {
  let submits = 0, broken = false, records = [];
  const snapshot = async () => {
    if (broken) throw Object.assign(new Error('账号已改变'), { status: 503 });
    return { ok: true, connected: true, premium: true, complete: true, total: records.length, reservations: records };
  };
  const browserConnector = {
    discover: async () => ({ accounts: [{ candidateId: 'candidate', pixivUserId: '123456', name: '实际创作账号' }] }),
    bind: async account => ({ account: { ...account, browser: { targetId: 'A'.repeat(32), postingEnabled: false } }, snapshot: await snapshot() }),
    snapshot,
    reserve: async (account, job, files, key) => {
      submits++;
      assert.ok(files.every(file => path.isAbsolute(file) && !file.includes('..')));
      records = [{ remoteId: 'illust:50', jobId: job.id, idempotencyKey: key, scheduledAt: job.scheduledAt, status: 'reserved' }];
      return { reservation: { remoteId: 'illust:50', status: 'reserved' } };
    },
  };
  const f = await fixture(t, { browserConnector });
  assert.equal((await f.request('/api/browser/discover', 'POST', {})).status, 409);
  const { account } = await liveJob(f);
  const route = `/api/accounts/${account.id}`;
  let r = await f.request(`${route}/browser`, 'POST', { candidateId: 'candidate' });
  assert.equal(r.status, 200);
  assert.equal(r.data.accounts[0].browser.postingEnabled, false);
  assert.equal(r.data.connectorConfigured, true);
  r = await f.request(route, 'PATCH', { name: '改备注', pixivUserId: '123456' });
  assert.ok(r.data.accounts[0].browser, 'saving unchanged ID must not disconnect the account');
  await f.request('/api/queue/tick', 'POST', {});
  assert.equal(submits, 0);
  await f.request(`${route}/browser-posting`, 'POST', { enabled: true });
  r = await f.request('/api/queue/tick', 'POST', {});
  assert.equal(submits, 1);
  assert.equal(r.data.jobs[0].status, 'reserved');
  broken = true;
  assert.equal((await f.request(`${route}/browser-sync`, 'POST', {})).status, 503);
  r = await f.request('/api/state');
  assert.equal(r.data.accounts[0].browser.postingEnabled, false);
  assert.equal(r.data.accounts[0].connected, false);
});

const emptyPixivSnapshot = () => ({ ok: true, connected: true, premium: true, complete: true, total: 0, reservations: [] });

test('workspace Pixiv sync reconciles publication and capacity without posting, including paused accounts', async t => {
  const snapshots = new Map(), reads = [];
  let submits = 0;
  const browserConnector = {
    bind: async account => ({ account: { ...account, browser: { targetId: account.id, postingEnabled: false } }, snapshot: snapshots.get(account.id) ?? emptyPixivSnapshot() }),
    snapshot: async account => { reads.push(account.id); return snapshots.get(account.id) ?? emptyPixivSnapshot(); },
    reserve: async () => { submits++; throw new Error('Status synchronization must never upload.'); },
  };
  const f = await fixture(t, { browserConnector });
  const { account, job, file } = await liveJob(f);
  const remote = { remoteId: 'illust:50', jobId: job.id, scheduledAt: job.scheduledAt, status: 'reserved' };
  snapshots.set(account.id, { ...emptyPixivSnapshot(), total: 1, reservations: [remote] });
  await f.request(`/api/accounts/${account.id}/browser`, 'POST', { candidateId: 'first' });
  await f.request(`/api/accounts/${account.id}/browser-posting`, 'POST', { enabled: true });
  const queued = await f.request('/api/jobs', 'POST', { accountId: account.id, title: 'Keep queued', files: [file], tags: ['オリジナル'], tagsConfirmed: true,
    scheduledAt: '2026-10-05T13:00:00.000Z', status: 'queued', content: { aiGenerated: true, rating: 'all', sexualContent: false } });
  const queuedId = queued.data.createdJobId;
  let r = await f.request('/api/accounts', 'POST', { name: '暂停账号', pixivUserId: '222222' });
  const paused = r.data.accounts.at(-1);
  await f.request(`/api/accounts/${paused.id}/browser`, 'POST', { candidateId: 'second' });
  await f.request(`/api/accounts/${paused.id}`, 'PATCH', { paused: true });
  r = await f.request('/api/accounts', 'POST', { name: '尚未绑定', pixivUserId: '333333' });
  const unbound = r.data.accounts.at(-1);
  snapshots.set(account.id, { ...emptyPixivSnapshot(), total: 8, reservations: [
    { ...remote, status: 'published', publishedAt: NOW },
    ...Array.from({ length: 8 }, (_, i) => ({ remoteId: `external-${i}`, status: 'reserved', scheduledAt: '2026-10-06T00:00:00.000Z' })),
  ] });
  reads.length = 0;
  r = await f.request('/api/pixiv/sync', 'POST', {});
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(reads, [account.id, paused.id]);
  assert.equal(submits, 0);
  assert.equal(r.data.jobs.find(j => j.id === job.id).status, 'published');
  assert.equal(r.data.jobs.find(j => j.id === queuedId).status, 'queued');
  assert.equal(r.data.accounts[0].remote.total, 8);
  assert.equal(r.data.accounts[0].remote.syncedAt, NOW);
  assert.equal(r.data.accounts[0].browser.postingEnabled, true);
  assert.equal(r.data.accounts[1].paused, true);
  assert.equal(r.data.accounts[1].browser.postingEnabled, false);
  assert.equal(r.data.settings.queuePaused, false);
  assert.deepEqual({ ...r.data.pixivSync, accounts: undefined }, { startedAt: NOW, completedAt: NOW, succeeded: 2, failed: 0, skipped: 1, accounts: undefined });
  assert.deepEqual(r.data.pixivSync.accounts.map(a => [a.accountId, a.status]), [[account.id, 'success'], [paused.id, 'success'], [unbound.id, 'skipped']]);
  const persisted = JSON.parse(await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8'));
  assert.deepEqual(persisted.states.live.pixivSync, r.data.pixivSync);
  await f.request('/api/settings', 'PATCH', { queuePaused: true });
  reads.length = 0;
  r = await f.request('/api/pixiv/sync', 'POST', {});
  assert.equal(r.data.pixivSync.succeeded, 2);
  assert.deepEqual(reads, [account.id, paused.id], 'Pausing the queue must not disable read-only synchronization.');
  assert.equal(submits, 0);
});

test('workspace Pixiv sync isolates failed or incomplete accounts and keeps their previous remote evidence', async t => {
  const failures = new Map();
  const prior = { ...emptyPixivSnapshot(), total: 1, reservations: [{ remoteId: 'old-reservation', status: 'reserved', scheduledAt: '2026-10-05T00:00:00.000Z' }] };
  const browserConnector = {
    bind: async account => ({ account: { ...account, browser: { targetId: account.id, postingEnabled: false } }, snapshot: prior }),
    snapshot: async account => {
      const value = failures.get(account.id);
      if (value instanceof Error) throw value;
      return value ?? prior;
    },
  };
  const f = await fixture(t, { browserConnector });
  await f.request('/api/mode', 'POST', { mode: 'live' });
  const accounts = [];
  for (let i = 1; i <= 3; i++) {
    const r = await f.request('/api/accounts', 'POST', { name: `账号 ${i}`, pixivUserId: String(i) });
    const account = r.data.accounts.at(-1); accounts.push(account);
    await f.request(`/api/accounts/${account.id}/browser`, 'POST', { candidateId: String(i) });
    await f.request(`/api/accounts/${account.id}/browser-posting`, 'POST', { enabled: true });
  }
  failures.set(accounts[0].id, new Error('登录已失效'));
  for (const malformed of [
    { ...emptyPixivSnapshot(), complete: false },
    { ...emptyPixivSnapshot(), total: 1 },
    { ...emptyPixivSnapshot(), total: 1, reservations: [null] },
    { ...emptyPixivSnapshot(), pixivUserId: 'different-account' },
  ]) {
    failures.set(accounts[1].id, malformed);
    const r = await f.request('/api/pixiv/sync', 'POST', {});
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.pixivSync.accounts.map(a => a.status), ['error', 'error', 'success']);
    assert.equal(r.data.pixivSync.failed, 2);
    assert.equal(r.data.pixivSync.succeeded, 1);
    assert.match(r.data.pixivSync.accounts[0].message, /登录已失效/);
    for (const account of r.data.accounts.slice(0, 2)) {
      assert.equal(account.connected, false);
      const identityLost = account.id === accounts[0].id || malformed.pixivUserId === 'different-account';
      assert.equal(account.browser.postingEnabled, !identityLost, 'Only identity loss disables the switch; incomplete reads preserve automatic retry while preventing posting.');
      assert.equal(account.remote.syncOk, false);
      assert.equal(account.remote.lastSyncAttemptAt, NOW);
      assert.equal(account.remote.total, 1);
      assert.deepEqual(account.remote.reservations, prior.reservations);
    }
    assert.equal(r.data.accounts[2].connected, true);
    assert.equal(r.data.accounts[2].browser.postingEnabled, true);
  }
});

test('workspace Pixiv sync uses configured external snapshots and refuses demo mode', async t => {
  const requests = [];
  const adapter = http.createServer((req, res) => {
    requests.push([req.method, req.url]);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(emptyPixivSnapshot()));
  });
  const adapterUrl = await listen(adapter);
  t.after(() => close(adapter));
  const f = await fixture(t, { connectorUrl: adapterUrl });
  let r = await f.request('/api/pixiv/sync', 'POST', {});
  assert.equal(r.status, 409);
  assert.match(r.data.error, /演示模式/);
  assert.deepEqual(requests, []);
  const { account, job } = await liveJob(f);
  r = await f.request('/api/accounts', 'POST', { name: '外部连接账号', pixivUserId: '222222' });
  const second = r.data.accounts.at(-1);
  r = await f.request('/api/pixiv/sync', 'POST', {});
  assert.equal(r.status, 200);
  assert.equal(r.data.pixivSync.succeeded, 2);
  assert.equal(r.data.pixivSync.skipped, 0);
  assert.equal(r.data.jobs.find(j => j.id === job.id).status, 'queued');
  assert.deepEqual(requests, [['GET', `/accounts/${account.id}/snapshot`], ['GET', `/accounts/${second.id}/snapshot`]]);
});

test('workspace sync requests shared Chrome connection approval only once per run', async t => {
 let reads=0;
 const browserConnector={
  bind:async account=>({account:{...account,browser:{targetId:account.id,postingEnabled:false}},snapshot:emptyPixivSnapshot()}),
  snapshot:async()=>{reads++;throw Object.assign(new Error('Chrome 尚未允许后台连接'),{code:'approval_required'});},
 };
 const f=await fixture(t,{browserConnector});await f.request('/api/mode','POST',{mode:'live'});
 for(const pixivUserId of ['1234','5678']) {
  const r=await f.request('/api/accounts','POST',{name:pixivUserId,pixivUserId});
  await f.request(`/api/accounts/${r.data.accounts.at(-1).id}/browser`,'POST',{candidateId:pixivUserId});
 }
 const r=await f.request('/api/pixiv/sync','POST',{});
 assert.equal(reads,1);assert.equal(r.data.pixivSync.failed,2);
 assert.ok(r.data.pixivSync.accounts.every(a=>a.message==='Chrome 尚未允许后台连接'));
});

test('workspace Pixiv sync rejects duplicate concurrent runs', async t => {
  let hold = false, reads = 0, started, release;
  const entered = new Promise(resolve => { started = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const browserConnector = {
    bind: async account => ({ account: { ...account, browser: { targetId: account.id, postingEnabled: false } }, snapshot: emptyPixivSnapshot() }),
    snapshot: async () => { reads++; if (hold) { started(); await blocked; } return emptyPixivSnapshot(); },
  };
  const f = await fixture(t, { browserConnector });
  const { account } = await liveJob(f);
  await f.request(`/api/accounts/${account.id}/browser`, 'POST', { candidateId: 'first' });
  hold = true;
  const pending = f.request('/api/pixiv/sync', 'POST', {});
  try {
    await entered;
    const duplicate = await f.request('/api/pixiv/sync', 'POST', {});
    assert.equal(duplicate.status, 409);
    assert.match(duplicate.data.error, /正在同步/);
    assert.equal(reads, 1);
  } finally { release(); }
  assert.equal((await pending).status, 200);
  assert.equal((await f.request('/api/pixiv/sync', 'POST', {})).status, 200);
  assert.equal(reads, 2);
});
