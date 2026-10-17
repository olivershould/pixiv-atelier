import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import { createBrowserConnector, normalizeRemote, remoteDate, scheduleLabels, unsupportedFields, titleMatches } from '../server/browser-connector.mjs';
import {clickSubmit} from '../server/browser-driver.mjs';

const NOW = '2026-10-12T10:00:00Z';
const targetA = 'A'.repeat(32), targetB = 'B'.repeat(32);
const data = (id = '101', reserved = []) => ({ identity: { pixivUserId: id, name: `用户${id}`, premium: true },
  publicationIndex: { complete: true, pixivUserId: id, artworkIds: [] },
  responses: [{ kind: 'illust', reserved, publishedIds: [] }, { kind: 'novel', reserved: [], publishedIds: [] }] });

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'huaxu-browser-test-'));
  t.after(async () => { assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir())); await fs.rm(dataDir, { recursive: true, force: true }); });
  const fake = { selected: targetA, swapped: false, closed: false, commands: [],
    tabs: async () => fake.closed ? [] : [
      { targetId: targetA, url: 'https://www.pixiv.net/', active: true },
      { targetId: targetB, url: 'https://www.pixiv.net/dashboard/works' },
      { targetId: 'C'.repeat(32), url: 'https://example.com/' }],
    select: async target => { fake.selected = target; },
    evaluate: async (fn, args) => {
      const id = fake.swapped ? '999' : fake.selected === targetA ? '101' : '202';
      if (fn.name === 'readIdentity') return { loggedIn: true, pixivUserId: id, name: `用户${id}`, premium: true };
      if (fn.name === 'readRemote') { if (id !== args.expectedId) throw new Error('Pixiv 登录账号已改变'); return data(id); }
      throw new Error(`Unexpected browser function ${fn.name}`);
    },
    command: async args => { fake.commands.push(args); },
  };
  const connector = await createBrowserConnector({ dataDir, driver: fake, now: () => new Date(NOW) });
  return { dataDir, fake, connector };
}

test('discovery separates two Pixiv identities; mismatched binding is rejected', async t => {
  const { connector } = await fixture(t);
  const result = await connector.discover();
  assert.deepEqual(result.accounts.map(a => a.pixivUserId), ['101', '202']);
  await assert.rejects(connector.bind({ id: 'local', pixivUserId: '202' }, result.accounts[0].candidateId), /不一致/);
  const bound = await connector.bind({ id: 'local', pixivUserId: '101' }, result.accounts[0].candidateId);
  assert.equal(bound.account.browser.targetId, targetA);
  assert.equal(bound.account.browser.postingEnabled, false);
  assert.equal(bound.snapshot.total, 0);
});

test('stale page identity and a closed pinned tab never authorize another account', async t => {
  const { connector, fake } = await fixture(t);
  const account = { id: 'local', pixivUserId: '101', browser: { targetId: targetA } };
  fake.swapped = true;
  await assert.rejects(connector.snapshot(account), /账号已改变/);
  fake.swapped = false; fake.closed = true;
  await assert.rejects(connector.snapshot(account), /标签页已关闭/);
  assert.deepEqual(fake.commands, []);
});

test('reservation normalization includes novels, validates IDs and preserves unknown time', () => {
  assert.equal(titleMatches('無題',''),true);
  assert.equal(titleMatches('Robin',''),false);
  assert.equal(titleMatches('Untitled','Mona'),false);
  const raw = data('101', [{ reserveId: '55', releaseDate: '2026-10-13 12:30:00', title: '作品', pageCount: 1 }]);
  raw.responses[1].reserved.push({ reserveId: '55', releaseDate: null });
  const result = normalizeRemote(raw);
  assert.equal(result.total, 2);
  assert.equal(result.reservations[0].remoteId, 'illust:55');
  assert.equal(result.reservations[0].scheduledAt, '2026-10-13T03:30:00.000Z');
  assert.equal(result.reservations[1].scheduledAt, null);
  assert.throws(() => normalizeRemote(data('101', [{}])), /ID/);
  assert.equal(remoteDate('tomorrow'), null);
  assert.deepEqual(scheduleLabels('2026-10-12T15:30:00Z'), { date: '2026年10月13日', time: '00:30 JST' });
});

test('unsupported metadata is reported before uploading and unknown attempts survive restart', async t => {
  const { connector, fake, dataDir } = await fixture(t);
  const account = { id: 'local', pixivUserId: '101', browser: { targetId: targetA, postingEnabled: true } };
  const job = { id: 'job', tags: ['tag'], content: { type: 'illust', seriesId: '4' }, scheduledAt: '2026-10-13T12:00:00Z' };
  assert.deepEqual(unsupportedFields(job), ['系列']);
  const result = await connector.reserve(account, job, ['local.png'], 'attempt-1');
  assert.equal(result.outcome, 'not_uploaded');
  assert.deepEqual(fake.commands, []);
  const restarted = await createBrowserConnector({ dataDir, driver: fake, now: () => new Date(NOW) });
  const second = await restarted.reserve(account, job, ['local.png'], 'attempt-1');
  assert.match(second.error, /不会自动重复/);
  assert.deepEqual(fake.commands, []);
});

test('binding alone never grants permission to publish', async t => {
  const { connector, fake } = await fixture(t);
  const result = await connector.reserve({ id: 'local', pixivUserId: '101', browser: { targetId: targetA, postingEnabled: false } }, {}, [], 'x');
  assert.equal(result.definitive, true);
  assert.equal(result.outcome, 'not_uploaded');
  assert.deepEqual(fake.commands, []);
});

function completeJob() {
  return { id: 'job', accountId: 'local', title: '测试', caption: '', tags: ['原创'], tagsConfirmed: true,
    scheduledAt: '2026-10-13T03:30:00Z', timezone: 'Asia/Shanghai', files: [{ id: 'file', name: 'test.png', size: 100, mime: 'image/png' }],
    content: { type: 'illust', rating: 'all', sexualContent: false, aiGenerated: false, visibility: 'public',
      allowTagEdit: true, allowComments: true, allowCollection: true, original: true,
      thumbnail: { page: 1, x: .5, y: .5 } } };
}
const completeForm = () => ({ submitEnabled: true, imageCount: 1, tags: ['原创'], scheduleLabels: ['2026年10月13日', '12:30 JST'], fields: [
  { name: 'title', value: '测试' }, { name: 'comment', value: '' },
  ...[['x_restrict', 'general'], ['sexual', 'false'], ['ai_type', 'notAiGenerated'], ['restrict', 'public'], ['allow_comment', 'true']].map(([name,value]) => ({ name, value, type: 'radio', checked: true })),
  ...[['allow_tag_edit',false],['allow-citation',true],['original',true],['reserve',true]].map(([name,checked]) => ({ name, type: 'checkbox', checked })),
] });

test('mismatched form readback never clicks submit; a transport failure during submit cannot retry after restart', async t => {
  const { connector, fake, dataDir } = await fixture(t);
  const baseEvaluate = fake.evaluate;
  let submitAttempts = 0, wrongTags = true;
  fake.openTab = async () => ({ targetId: targetA, url: 'https://www.pixiv.net/illustration/create' });
  fake.evaluate = async (fn, arg) => {
    if (fn.name === 'readForm') { const form = completeForm(); if (wrongTags) form.tags = ['错误标签']; return form; }
    if (fn.name === 'chooseSchedule') return 'chosen';
    if (['readRemote', 'readIdentity'].includes(fn.name)) return baseEvaluate(fn, arg);
    submitAttempts++; throw new Error('connection dropped after click');
  };
  const account = { id: 'local', pixivUserId: '101', browser: { targetId: targetA, postingEnabled: true } };
  const first = await connector.reserve(account, completeJob(), ['file.png'], 'mismatch');
  assert.equal(first.outcome, 'not_uploaded');
  assert.match(first.error, /回读/);
  assert.equal(submitAttempts, 0);
  assert.ok(fake.commands.some(args=>args[0]==='wait'&&args[1]==='--fn'), 'hydration must finish before editing');
  assert.deepEqual(fake.commands.filter(args=>args[0]==='fill'&&args[1]==='input[placeholder="标签"]').map(args=>args[2]), ['原创']);
  wrongTags = false;
  const result = await connector.reserve(account, completeJob(), ['file.png'], 'ambiguous');
  assert.equal(result.definitive, undefined);
  assert.equal(submitAttempts, 1);
  const restarted = await createBrowserConnector({ dataDir, driver: fake, now: () => new Date(NOW) });
  await restarted.reserve(account, completeJob(), ['file.png'], 'ambiguous');
  assert.equal(submitAttempts, 1, 'an ambiguous click must never be replayed');
});

test('responsive hidden submit button is excluded and unavailable button reports definitely not clicked',()=>{
 let clicked=0;
 const button=(visible,disabled=false,header=false)=>({textContent:'投稿',disabled,checkVisibility:()=>visible,classList:{contains:()=>header},click:()=>clicked++});
 const previous=globalThis.document;
 try {
  globalThis.document={querySelectorAll:()=>[button(true,false,true),button(true),button(false)]};
  assert.deepEqual(clickSubmit(),{clicked:true});assert.equal(clicked,1);
  globalThis.document={querySelectorAll:()=>[button(true,true),button(false)]};
  assert.deepEqual(clickSubmit(),{clicked:false});assert.equal(clicked,1);
 } finally {globalThis.document=previous;}
});

test('adopting a changed remote schedule requires consent and the same previously linked reservation',async t=>{
 const {fake,dataDir}=await fixture(t);
 const idempotencyKey='existing-reservation',key=createHash('sha256').update(idempotencyKey).digest('hex');
 const job={...completeJob(),idempotencyKey,remoteId:'illust:55'};
 await fs.writeFile(path.join(dataDir,'browser-ledger.json'),JSON.stringify({[key]:{accountId:'local',pixivUserId:'101',jobId:job.id,idempotencyKey,remoteId:job.remoteId,scheduledAt:job.scheduledAt,
  publicationExpected:{title:job.title,pageCount:1,illustType:0,scheduledAt:job.scheduledAt,tags:['frozen-submission-tag'],xRestrict:1}}}));
 const baseEvaluate=fake.evaluate;
 fake.evaluate=(fn,args)=>fn.name==='readRemote'?data('101',[{reserveId:'55',title:'测试',pageCount:1,releaseDate:'2026-10-14T09:00:00+09:00'},{reserveId:'56',title:'测试',pageCount:1,releaseDate:'2026-10-14T09:00:00+09:00'}]):baseEvaluate(fn,args);
 const connector=await createBrowserConnector({dataDir,driver:fake,now:()=>new Date(NOW)});
 const account={id:'local',pixivUserId:'101',browser:{targetId:targetA}};
 await assert.rejects(connector.reconcile(account,job,{remoteId:'illust:55'}),/明确选择/);
 await assert.rejects(connector.reconcile(account,job,{remoteId:'illust:56',adoptRemoteSchedule:true}),/同一预约/);
 const result=await connector.reconcile(account,job,{remoteId:'illust:55',adoptRemoteSchedule:true});
 assert.equal(result.reservations.find(r=>r.remoteId==='illust:55').scheduledAt,'2026-10-14T00:00:00.000Z');
 assert.equal(JSON.parse(await fs.readFile(path.join(dataDir,'browser-ledger.json'),'utf8'))[key].scheduledAt,'2026-10-14T00:00:00.000Z');
 const savedExpected=JSON.parse(await fs.readFile(path.join(dataDir,'browser-ledger.json'),'utf8'))[key].publicationExpected;
 assert.deepEqual(savedExpected.tags,['frozen-submission-tag']);assert.equal(savedExpected.xRestrict,1);
 assert.deepEqual(fake.commands,[], 'reconciliation never uploads or clicks');
});
