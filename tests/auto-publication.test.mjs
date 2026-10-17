import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { createBrowserConnector } from '../server/browser-connector.mjs';
import { readRemote, readPublished } from '../server/browser-driver.mjs';
import { reconcileRemote, planReservations } from '../server/queue.mjs';

const NOW = '2026-10-14T08:00:00.000Z', WHEN = '2026-10-14T02:00:00.000Z', BEFORE = '2026-10-13T08:00:00.000Z';
const account = { id: 'account', pixivUserId: '101', browser: { targetId: 'A'.repeat(32), postingEnabled: true } };
const job = (id = 'job') => ({ id, accountId: account.id, status: 'reserved', idempotencyKey: `key-${id}`, remoteId: `illust:${id === 'job' ? '55' : '56'}`,
  title: 'Robin', scheduledAt: WHEN, timezone: 'Asia/Tokyo', files: [{ id: 'file', name: 'image.png', size: 100, mime: 'image/png' }],
  content: { type: 'illust', rating: 'all', sexualContent: false, aiGenerated: true, visibility: 'public', allowComments: true,
    allowTagEdit: true, allowCollection: true, original: false, thumbnail: { page: 1, x: .5, y: .5 } }, tags: ['Robin'], tagsConfirmed: true });
const record = (id = 'job') => ({ accountId: account.id, pixivUserId: account.pixivUserId, jobId: id, idempotencyKey: `key-${id}`,
  remoteId: job(id).remoteId, title: 'Robin', scheduledAt: WHEN, phase: 'confirmed', confirmedAt: BEFORE,
  publicationExpected: { title: 'Robin', scheduledAt: WHEN, pageCount: 1, illustType: 0 },
  publishedBaselineIds: ['100'], publicationBaselineAt: BEFORE });
const published = (id = '200', changes = {}) => ({ artworkId: id, userId: '101', title: 'Robin', createDate: WHEN, pageCount: 1, illustType: 0, ...changes });
const hash = value => createHash('sha256').update(value).digest('hex');

async function fixture(t, records = [record()]) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'huaxu-auto-published-'));
  t.after(async () => { assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir())); await fs.rm(dataDir, { recursive: true, force: true }); });
  const ledgerPath = path.join(dataDir, 'browser-ledger.json');
  await fs.writeFile(ledgerPath, JSON.stringify(Object.fromEntries(records.map(row => [hash(row.idempotencyKey), row]))));
  const fake = { reserved: [], ids: ['100', '200'], complete: true, details: { '200': published() }, calls: [], clock: NOW,
    tabs: async () => [{ targetId: account.browser.targetId, url: 'https://www.pixiv.net/' }], select: async () => {},
    evaluate: async (fn, arg) => {
      fake.calls.push({ name: fn.name, arg });
      if (fn.name === 'readRemote') return { identity: { pixivUserId: '101', premium: true },
        responses: [{ kind: 'illust', reserved: fake.reserved }, { kind: 'novel', reserved: [] }],
        ...(arg.includePublishedIndex ? { publicationIndex: { complete: fake.complete, pixivUserId: '101', artworkIds: fake.ids } } : {}) };
      if (fn.name === 'readPublished') {
        const value = fake.details[arg.artworkId];
        if (value instanceof Error) throw value;
        return value;
      }
      if (fn.name === 'readAccountAvatar') return { pixivUserId: '101', avatarUrl: 'https://i.pximg.net/user-profile/img/avatar.png' };
      throw new Error(`Unexpected browser function: ${fn.name}`);
    },
    command: async () => { throw new Error('Snapshots must never upload or click'); },
  };
  const restart = () => createBrowserConnector({ dataDir, driver: fake, now: () => new Date(fake.clock) });
  return { fake, connector: await restart(), restart, readLedger: async () => JSON.parse(await fs.readFile(ledgerPath, 'utf8')) };
}

test('confirmed missing reservation is uniquely verified, persists actual publication time, and releases local occupancy', async t => {
  const f = await fixture(t);
  f.fake.details['200'] = fullPublished();
  const snapshot = await f.connector.snapshot(account, { jobs: [job()] });
  assert.equal(snapshot.total, 0);
  assert.deepEqual(snapshot.reservations.map(row => [row.status, row.artworkId, row.publishedAt, row.publicationVerifiedAt]), [['published', '200', WHEN, NOW]]);
  assert.equal(snapshot.publicationChecks[0].status, 'published');
  const ledger = (await f.readLedger())[hash('key-job')];
  assert.equal(ledger.phase, 'published'); assert.equal(ledger.publishedAt, WHEN); assert.equal(ledger.publicationVerifiedAt, NOW);
  const state = { accounts: [account], jobs: [job()], settings: {} };
  const reconciled = reconcileRemote(state, account.id, snapshot, NOW);
  assert.equal(reconciled.jobs[0].status, 'published'); assert.equal(reconciled.jobs[0].artworkId, '200');
  reconciled.accounts[0].connected = true; reconciled.accounts[0].premium = true;
  reconciled.jobs.push({ ...job('waiting'), status: 'queued', scheduledAt: '2026-10-15T02:00:00Z', remoteId: undefined, idempotencyKey: undefined });
  assert.equal(planReservations(reconciled, NOW).actions.length, 1);
  const restarted = await f.restart(); f.fake.calls.length = 0;
  assert.equal((await restarted.snapshot(account)).reservations[0].artworkId, '200');
  assert.equal(f.fake.calls.some(call => call.name === 'readPublished'), false);
});

test('not due or still visible reservations never become published', async t => {
  const f = await fixture(t);
  f.fake.clock = BEFORE;
  assert.equal((await f.connector.snapshot(account)).reservations.length, 0);
  f.fake.clock = NOW;
  f.fake.reserved = [{ reserveId: '55', releaseDate: WHEN, title: 'Robin', pageCount: 1 }];
  assert.equal((await f.connector.snapshot(account)).reservations[0].status, 'reserved');
  assert.equal(f.fake.calls.some(call => call.name === 'readPublished'), false);
});

test('old still-visible reservation receives metadata and a full baseline only from its exact linked local job', async t => {
  const old = record(); delete old.publicationExpected; delete old.publishedBaselineIds; delete old.publicationBaselineAt;
  const f = await fixture(t, [old]);
  f.fake.clock = BEFORE; f.fake.ids = ['100'];
  f.fake.reserved = [{ reserveId: '55', releaseDate: WHEN, title: 'Robin', pageCount: 1 }];
  await f.connector.snapshot(account, { jobs: [{ ...job(), idempotencyKey: 'other-key' }] });
  assert.equal((await f.readLedger())[hash('key-job')].publicationExpected, undefined);
  await f.connector.snapshot(account, { jobs: [job()] });
  assert.deepEqual((await f.readLedger())[hash('key-job')].publishedBaselineIds, ['100']);
  f.fake.clock = NOW; f.fake.ids.push('200'); f.fake.reserved = [];
  assert.equal((await f.connector.snapshot(account)).reservations[0].status, 'published');
});

test('already missing legacy reservation without baseline stays pending; no title-only inference', async t => {
  const old = record(); delete old.publishedBaselineIds; delete old.publicationBaselineAt;
  const f = await fixture(t, [old]);
  const snapshot = await f.connector.snapshot(account, { jobs: [job()] });
  assert.deepEqual(snapshot.reservations, []);
  assert.equal(snapshot.publicationChecks[0].reason, 'baseline_missing');
  assert.equal(f.fake.calls.some(call => call.name === 'readPublished'), false);
});

test('unknown submission outcomes and foreign-account ledger entries are never auto-adopted', async t => {
  const f = await fixture(t, [{ ...record(), phase: 'unknown' }, { ...record('other'), pixivUserId: '202' }]);
  assert.deepEqual((await f.connector.snapshot(account)).reservations, []);
  assert.equal(f.fake.calls.some(call => call.name === 'readPublished'), false);
});

test('same title alone, wrong author/type/page count/time, incomplete schema, and old baseline work cannot confirm publication', async t => {
  for (const changes of [{ title: 'Other' }, { userId: '202' }, { illustType: 1 }, { pageCount: 2 }, { createDate: BEFORE },
    { createDate: '2026-10-14T02:01:00Z' }, { createDate: '2026-10-14T01:59:59Z' }, { illustType: undefined }, { pageCount: undefined }]) {
    const f = await fixture(t); f.fake.details['200'] = published('200', changes);
    assert.deepEqual((await f.connector.snapshot(account)).reservations, [], JSON.stringify(changes));
  }
  const f = await fixture(t, [{ ...record(), publishedBaselineIds: ['100', '200'] }]);
  assert.deepEqual((await f.connector.snapshot(account)).reservations, []);
  assert.equal(f.fake.calls.some(call => call.name === 'readPublished'), false);
});

test('blank original title accepts only Pixiv untitled representations', async t => {
  const blank = record(); blank.title = ''; blank.publicationExpected.title = '';
  const f = await fixture(t, [blank]); f.fake.details['200'].title = '無題';
  assert.equal((await f.connector.snapshot(account)).reservations[0].status, 'published');
});

test('multiple matching artworks and one matching artwork for two jobs both stay ambiguous', async t => {
  const f = await fixture(t); f.fake.ids.push('201'); f.fake.details['201'] = published('201');
  const snapshot = await f.connector.snapshot(account);
  assert.deepEqual(snapshot.reservations, []); assert.equal(snapshot.publicationChecks[0].reason, 'publication_evidence_missing');
  const paired = await fixture(t, [record(), record('second')]);
  const result = await paired.connector.snapshot(account);
  assert.deepEqual(result.reservations, []);
  assert.deepEqual(result.publicationChecks.map(row => row.reason), ['publication_evidence_missing', 'publication_evidence_missing']);
});

test('a competing uncertain submission or legacy row without baseline also prevents false attribution', async t => {
  for (const phase of ['unknown', 'confirmed']) {
    const other = record('second'); other.phase = phase; delete other.publishedBaselineIds; delete other.publicationBaselineAt;
    const f = await fixture(t, [record(), other]);
    const snapshot = await f.connector.snapshot(account);
    assert.deepEqual(snapshot.reservations, []);
    assert.equal(snapshot.publicationChecks.find(row => row.jobId === 'job').reason, 'publication_evidence_missing');
  }
});

const withEvidence = (id = 'job', tags = ['Robin'], xRestrict = 0) => {
  const value = record(id); Object.assign(value.publicationExpected, { tags, xRestrict }); return value;
};
const fullPublished = (id = '200', tags = ['Robin'], xRestrict = 0) => published(id, { tags, xRestrict });

test('exact immutable job links upgrade old records and separate same-minute works by complete tag sets', async t => {
  const f = await fixture(t, [record(), record('second')]);
  f.fake.ids.push('201'); f.fake.details = { '200': fullPublished('200', ['Robin', 'smile']), '201': fullPublished('201') };
  const jobs = [job(), { ...job('second'), tags: ['smile', 'Robin'] }];
  const snapshot = await f.connector.snapshot(account, { jobs });
  assert.deepEqual(snapshot.reservations.map(row => [row.jobId, row.artworkId]), [['job', '201'], ['second', '200']]);
  assert.ok(snapshot.publicationChecks.every(row => row.status === 'published' && row.checkedAt === NOW));
  const saved = await f.readLedger();
  assert.deepEqual(saved[hash('key-second')].publicationExpected.tags, ['Robin', 'smile']);
  assert.equal(saved[hash('key-job')].publicationCheck.artworkId, '201');
  const restarted = await f.restart(); f.fake.calls.length = 0;
  const again = await restarted.snapshot(account, { jobs: jobs.map(row => ({ ...row, tags: ['changed'] })) });
  assert.deepEqual(again.reservations.map(row => row.artworkId), ['201', '200']);
  assert.equal(f.fake.calls.some(call => call.name === 'readPublished'), false);
});

test('complete equal tag sets can be distinguished by the frozen age rating', async t => {
  const f = await fixture(t, [withEvidence(), withEvidence('second', ['Robin'], 1)]);
  f.fake.ids.push('201'); f.fake.details = { '200': fullPublished('200', ['Robin'], 1), '201': fullPublished('201') };
  const snapshot = await f.connector.snapshot(account);
  assert.deepEqual(snapshot.reservations.map(row => [row.jobId, row.artworkId]), [['job', '201'], ['second', '200']]);
});

test('same complete evidence remains ambiguous and never pairs by reservation or artwork order', async t => {
  const f = await fixture(t, [withEvidence(), withEvidence('second')]);
  f.fake.ids.push('201'); f.fake.details['200'] = fullPublished(); f.fake.details['201'] = fullPublished('201');
  const snapshot = await f.connector.snapshot(account);
  assert.deepEqual(snapshot.reservations, []);
  assert.ok(snapshot.publicationChecks.every(row => row.reason === 'ambiguous_match'));
  const saved = await f.readLedger();
  assert.equal(saved[hash('key-job')].publicationCheck.checkedAt, NOW);
  assert.equal(saved[hash('key-job')].publicationCheck.reason, 'ambiguous_match');
});

test('an unmatched work cannot bypass frozen evidence after its rival is published on an earlier sync', async t => {
  const f = await fixture(t, [withEvidence('job', ['first']), withEvidence('second', ['second'])]);
  f.fake.ids.push('201'); f.fake.details = { '200': fullPublished('200', ['first']), '201': fullPublished('201', ['edited']) };
  const first = await f.connector.snapshot(account);
  assert.deepEqual(first.reservations.map(row => [row.jobId, row.artworkId]), [['job', '200']]);
  assert.equal(first.publicationChecks.find(row => row.jobId === 'second').reason, 'publication_evidence_mismatch');
  const restarted = await f.restart(), second = await restarted.snapshot(account);
  assert.deepEqual(second.reservations.map(row => [row.jobId, row.artworkId]), [['job', '200']]);
  assert.equal(second.publicationChecks.find(row => row.jobId === 'second').reason, 'publication_evidence_mismatch');
  assert.equal((await f.readLedger())[hash('key-second')].phase, 'confirmed');
  const partial = record(); partial.publicationExpected.tags = ['Robin'];
  const incomplete = await fixture(t, [partial]); incomplete.fake.details['200'] = fullPublished();
  const result = await incomplete.connector.snapshot(account, { jobs: [job()] });
  assert.deepEqual(result.reservations, []);
  assert.equal(result.publicationChecks[0].reason, 'publication_evidence_missing');
  assert.equal((await incomplete.readLedger())[hash('key-job')].publicationExpected.xRestrict, undefined);
});

test('missing or edited remote evidence preserves uncertainty across all matching candidates', async t => {
  for (const patch of [{ tags: null }, { tags: undefined }, { xRestrict: null }, { xRestrict: '0' }, { tags: ['other'] }, { xRestrict: 2 }]) {
    const f = await fixture(t, [withEvidence()]); f.fake.ids.push('201');
    f.fake.details = { '200': { ...fullPublished(), ...patch }, '201': fullPublished('201', ['different']) };
    const snapshot = await f.connector.snapshot(account);
    assert.deepEqual(snapshot.reservations, [], JSON.stringify(patch));
    assert.ok(['publication_evidence_missing', 'publication_evidence_mismatch'].includes(snapshot.publicationChecks[0].reason));
  }
  const f = await fixture(t, [withEvidence()]); f.fake.ids.push('201');
  f.fake.details = { '200': fullPublished(), '201': published('201') };
  assert.deepEqual((await f.connector.snapshot(account)).reservations, [], 'one unreadable rival cannot be excluded');
});

test('evidence backfill requires one exact job identity, base metadata and original account', async t => {
  for (const patch of [{ accountId: 'elsewhere' }, { id: 'wrong-job' }, { idempotencyKey: 'different-attempt' }, { remoteId: 'illust:999' },
    { pixivUserId: '202' }, { title: 'Different' }, { scheduledAt: BEFORE }, { files: [{}, {}] },
    { content: { ...job().content, type: 'manga' } }, { status: 'draft' }, { tagsConfirmed: false }]) {
    const f = await fixture(t); f.fake.ids.push('201');
    f.fake.details = { '200': fullPublished(), '201': fullPublished('201', ['different']) };
    const snapshot = await f.connector.snapshot(account, { jobs: [{ ...job(), ...patch }] });
    assert.deepEqual(snapshot.reservations, [], JSON.stringify(patch));
    assert.equal(Object.hasOwn((await f.readLedger())[hash('key-job')].publicationExpected, 'tags'), false);
  }
  const duplicate = await fixture(t); duplicate.fake.ids.push('201');
  duplicate.fake.details = { '200': fullPublished(), '201': fullPublished('201', ['different']) };
  assert.deepEqual((await duplicate.connector.snapshot(account, { jobs: [job(), job()] })).reservations, []);
});

test('frozen evidence cannot be overwritten and a missing publication baseline cannot be manufactured', async t => {
  const f = await fixture(t, [withEvidence('job', ['original'])]); f.fake.ids.push('201');
  f.fake.details = { '200': fullPublished(), '201': fullPublished('201', ['different']) };
  assert.deepEqual((await f.connector.snapshot(account, { jobs: [job()] })).reservations, []);
  assert.deepEqual((await f.readLedger())[hash('key-job')].publicationExpected.tags, ['original']);
  const malformed = withEvidence(); malformed.publicationExpected.pageCount = null;
  const broken = await fixture(t, [malformed]);
  assert.deepEqual((await broken.connector.snapshot(account, { jobs: [job()] })).reservations, []);
  assert.equal((await broken.readLedger())[hash('key-job')].publicationExpected.pageCount, null);
  const old = record(); delete old.publishedBaselineIds; delete old.publicationBaselineAt;
  const missing = await fixture(t, [old]);
  const result = await missing.connector.snapshot(account, { jobs: [job()] });
  assert.equal(result.publicationChecks[0].reason, 'baseline_missing');
  assert.equal((await missing.readLedger())[hash('key-job')].publishedBaselineIds, undefined);
});

test('unknown competing submissions block attribution unless their complete frozen evidence excludes it', async t => {
  for (const enhanced of [false, true]) {
    const unknown = enhanced ? withEvidence('second', ['different']) : record('second'); unknown.phase = 'unknown';
    const f = await fixture(t, [withEvidence(), unknown]); f.fake.details['200'] = fullPublished();
    const snapshot = await f.connector.snapshot(account, { jobs: [job('second')] });
    assert.equal(snapshot.reservations.length, enhanced ? 1 : 0);
    if (!enhanced) assert.equal(snapshot.publicationChecks[0].reason, 'ambiguous_match');
  }
  const other = withEvidence('second'); other.pixivUserId = '202';
  const f = await fixture(t, [withEvidence(), other]); f.fake.details['200'] = fullPublished();
  assert.equal((await f.connector.snapshot(account)).reservations[0].artworkId, '200');
});

test('manga lives in the illust reservation stream but must match manga detail type', async t => {
  const manga = record(); manga.publicationExpected.illustType = 1;
  const f = await fixture(t, [manga]); f.fake.details['200'].illustType = 1;
  assert.equal((await f.connector.snapshot(account)).reservations[0].artworkId, '200');
});

test('already claimed artwork cannot be assigned again, including another local binding of the same Pixiv account', async t => {
  const existing = { ...record('other'), accountId: 'previous-binding', publishedId: '200', phase: 'published', publicationVerifiedAt: BEFORE };
  const f = await fixture(t, [record(), existing]);
  assert.deepEqual((await f.connector.snapshot(account)).reservations, []);
});

test('failed candidate, incomplete full index, and excessive candidate count preserve uncertainty', async t => {
  const failed = await fixture(t); failed.fake.ids.push('201'); failed.fake.details['201'] = new Error('network');
  let result = await failed.connector.snapshot(account);
  assert.deepEqual(result.reservations, []); assert.equal(result.publicationChecks[0].reason, 'candidate_read_failed');
  const incomplete = await fixture(t); incomplete.fake.complete = false;
  result = await incomplete.connector.snapshot(account);
  assert.equal(result.publicationChecks[0].reason, 'published_index_unavailable');
  const large = await fixture(t); large.fake.ids = Array.from({ length: 101 }, (_, i) => String(1000 + i));
  result = await large.connector.snapshot(account);
  assert.equal(result.publicationChecks[0].reason, 'candidate_limit');
  assert.equal(large.fake.calls.some(call => call.name === 'readPublished'), false);
});

test('avatar best effort does not invalidate publication evidence or trigger any clicks', async t => {
  const f = await fixture(t); const evaluate = f.fake.evaluate;
  f.fake.details['200'] = fullPublished();
  f.fake.evaluate = (fn, args) => fn.name === 'readAccountAvatar' ? Promise.reject(new Error('offline')) : evaluate(fn, args);
  assert.equal((await f.connector.snapshot(account, { jobs: [job()] })).reservations[0].status, 'published');
});

function preparedForm() {
  return { submitEnabled: true, imageCount: 1, tags: ['Robin'], scheduleLabels: ['2026年10月14日', '11:00 JST'], fields: [
    { name: 'title', value: 'Robin' }, { name: 'comment', value: '' },
    ...[['x_restrict', 'general'], ['sexual', 'false'], ['ai_type', 'aiGenerated'], ['restrict', 'public'], ['allow_comment', 'true']]
      .map(([name, value]) => ({ name, value, type: 'radio', checked: true })),
    ...[['allow_tag_edit', false], ['allow-citation', true], ['original', false], ['reserve', true]]
      .map(([name, checked]) => ({ name, type: 'checkbox', checked })),
  ] };
}

test('new submissions persist exact metadata and complete baseline before clicking; baseline failure never clicks', async t => {
  for (const complete of [true, false]) {
    const f = await fixture(t, []); f.fake.complete = complete; f.fake.clock = BEFORE; f.fake.ids = ['100'];
    const evaluate = f.fake.evaluate; let clicks = 0;
    f.fake.command = async () => {};
    f.fake.openTab = async () => ({ targetId: account.browser.targetId, url: 'https://www.pixiv.net/illustration/create' });
    f.fake.evaluate = async (fn, args) => {
      if (fn.name === 'readIdentity') return { loggedIn: true, pixivUserId: '101' };
      if (fn.name === 'readForm') return preparedForm();
      if (fn.name === 'chooseSchedule') return 'chosen';
      if (fn.name === 'clickSubmit') {
        clicks++;
        const saved = (await f.readLedger())[hash('new-attempt')];
        assert.deepEqual(saved.publishedBaselineIds, ['100']);
        assert.deepEqual(saved.publicationExpected, { ...record().publicationExpected, tags: ['Robin'], xRestrict: 0 });
        assert.equal(saved.phase, 'submitting');
        throw new Error('transport fails after click');
      }
      return evaluate(fn, args);
    };
    const result = await f.connector.reserve(account, { ...job(), status: 'queued' }, ['image.png'], 'new-attempt');
    assert.equal(clicks, complete ? 1 : 0);
    assert.equal(result.outcome, complete ? undefined : 'not_uploaded');
    if (!complete) assert.match(result.error, /基线/);
  }
});

test('pause before preparation or during form preparation never clicks and returns definitive paused outcome', async t => {
  for (const stopAt of ['before', 'during']) {
    const f = await fixture(t, []); f.fake.clock = BEFORE; f.fake.ids = ['100'];
    const evaluate = f.fake.evaluate; let stopped = stopAt === 'before', clicks = 0, opened = 0;
    f.fake.command = async () => {};
    f.fake.openTab = async () => { opened++; return { targetId: account.browser.targetId, url: 'https://www.pixiv.net/illustration/create' }; };
    f.fake.evaluate = async (fn, args) => {
      if (fn.name === 'readIdentity') return { loggedIn: true, pixivUserId: '101' };
      if (fn.name === 'readForm') { stopped = true; return preparedForm(); }
      if (fn.name === 'chooseSchedule') return 'chosen';
      if (fn.name === 'clickSubmit') { clicks++; throw new Error('must never click'); }
      return evaluate(fn, args);
    };
    const result = await f.connector.reserve(account, { ...job(), status: 'queued' }, ['image.png'], 'paused-attempt', { shouldStop: () => stopped });
    assert.deepEqual(result, { definitive: true, outcome: 'not_uploaded', paused: true, error: '预约已暂停，尚未提交。' });
    assert.equal(clicks, 0); assert.equal(opened, stopAt === 'before' ? 0 : 1);
    assert.equal((await f.readLedger())[hash('paused-attempt')].phase, 'not_submitted');
  }
});

test('pause after the submit click cannot turn an unknown result into not_uploaded', async t => {
  const f = await fixture(t, []); f.fake.clock = BEFORE; f.fake.ids = ['100'];
  const evaluate = f.fake.evaluate; let stopped = false;
  f.fake.command = async () => {};
  f.fake.openTab = async () => ({ targetId: account.browser.targetId, url: 'https://www.pixiv.net/illustration/create' });
  f.fake.evaluate = async (fn, args) => {
    if (fn.name === 'readIdentity') return { loggedIn: true, pixivUserId: '101' };
    if (fn.name === 'readForm') return preparedForm();
    if (fn.name === 'chooseSchedule') return 'chosen';
    if (fn.name === 'clickSubmit') { stopped = true; throw new Error('connection lost after click'); }
    return evaluate(fn, args);
  };
  const result = await f.connector.reserve(account, { ...job(), status: 'queued' }, ['image.png'], 'clicked-attempt', { shouldStop: () => stopped });
  assert.equal(result.definitive, undefined); assert.equal(result.outcome, undefined); assert.equal(result.paused, undefined);
  assert.equal((await f.readLedger())[hash('clicked-attempt')].phase, 'unknown');
});

function driverPage({ body, identity = '101', profile = { illusts: { '100': null }, manga: { '200': null } } } = {}) {
  const requests = [];
  const props = { isLoggedIn: true, serverSerializedPreloadedState: JSON.stringify({ userData: { self: { id: identity, premium: true } } }) };
  const context = vm.createContext({ location: { origin: 'https://www.pixiv.net' }, AbortController, setTimeout, clearTimeout,
    DOMParser: class { parseFromString() { return { getElementById: () => ({ textContent: JSON.stringify({ props: { pageProps: props } }) }) }; } },
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (url === '/dashboard/works') return { ok: true, text: async () => 'identity fixture' };
      if (url.startsWith('/ajax/dashboard/')) return { ok: true, json: async () => ({ body: { data: { reservedWorks: [], works: [] } } }) };
      if (url.startsWith('/ajax/user/')) return { ok: true, json: async () => ({ body: profile }) };
      if (url === '/ajax/illust/200') return { ok: true, json: async () => ({ body }) };
      throw new Error(`Unexpected ${url}`);
    } });
  return { requests, run: (fn, args) => vm.runInContext(`(${fn.toString()})(${JSON.stringify({ expectedId: '101', ...args })})`, context) };
}

test('driver optionally reads complete illust+manga index after fresh account verification, retaining no content or credentials', async () => {
  const f = driverPage(); const data = await f.run(readRemote, { includePublishedIndex: true });
  assert.deepEqual([...data.publicationIndex.artworkIds], ['100', '200']);
  assert.equal(data.publicationIndex.complete, true);
  assert.equal(f.requests[0].url, '/dashboard/works');
  assert.ok(f.requests.every(request => request.options.cache === 'no-store' && !request.options.method));
  const wrong = driverPage({ identity: '202' });
  await assert.rejects(wrong.run(readRemote, { includePublishedIndex: true }), /账号已改变/);
  assert.equal(wrong.requests.length, 1);
  const malformed = driverPage({ profile: { illusts: {} } });
  assert.equal((await malformed.run(readRemote, { includePublishedIndex: true })).publicationIndex.complete, false);
});

test('published detail driver rejects drafts/reservations and foreign ownership and exposes timestamp/type for validation', async () => {
  const base = { id: '200', userId: '101', title: 'Robin', pageCount: 1, createDate: WHEN, illustType: 0 };
  for (const patch of [{ isDraft: true }, { isReserved: true }, { status: 'scheduled' }, { userId: '202' }, { id: '999' }]) {
    await assert.rejects(driverPage({ body: { ...base, ...patch } }).run(readPublished, { artworkId: '200' }));
  }
  const result = await driverPage({ body: base }).run(readPublished, { artworkId: '200' });
  assert.equal(result.createDate, WHEN); assert.equal(result.illustType, 0);
});

test('published detail exports only complete exact tags and numeric rating; missing values stay unknown', async () => {
  const base = { id: '200', userId: '101', title: 'Robin', pageCount: 1, createDate: WHEN, illustType: 0,
    tags: { tags: [{ tag: 'smile' }, { tag: 'Robin' }] }, xRestrict: 0 };
  const result = await driverPage({ body: base }).run(readPublished, { artworkId: '200' });
  assert.deepEqual([...result.tags], ['Robin', 'smile']); assert.equal(result.xRestrict, 0);
  for (const tags of [undefined, { tags: [{ tag: 'Robin' }, {}] }, { tags: [{ tag: 'Robin' }, { tag: 'Robin' }] }, { tags: [{ tag: '' }] }]) {
    assert.equal((await driverPage({ body: { ...base, tags } }).run(readPublished, { artworkId: '200' })).tags, null);
  }
  for (const xRestrict of [undefined, null, '0', 3, -1]) {
    assert.equal((await driverPage({ body: { ...base, xRestrict } }).run(readPublished, { artworkId: '200' })).xRestrict, null);
  }
});
