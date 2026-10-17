import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBrowserConnector, scheduleLabels } from '../server/browser-connector.mjs';

const NOW = '2026-10-16T00:00:00Z';
const targets = { '101': 'A'.repeat(32), '202': 'B'.repeat(32) };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(predicate) {
  const deadline = Date.now() + 4000;
  while (!predicate()) { if (Date.now() >= deadline) throw new Error('Concurrent operation did not arrive'); await new Promise(done => setTimeout(done, 5)); }
}
const account = (id = '101', localId = `local-${id}`) => ({ id: localId, pixivUserId: id, browser: { targetId: targets[id], postingEnabled: true } });
const job = (id, owner = account()) => ({ id, accountId: owner.id, title: 'Same title', caption: '', tags: ['原创'], tagsConfirmed: true,
  scheduledAt: '2026-10-17T00:00:00Z', timezone: 'Asia/Tokyo', files: [{ id: `file-${id}`, name: 'test.png', size: 10 }],
  content: { type: 'illust', rating: 'all', sexualContent: false, aiGenerated: true, visibility: 'public',
    allowTagEdit: true, allowComments: true, allowCollection: true, original: true, thumbnail: { page: 1, x: .5, y: .5 } } });

async function fixture(t, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'atelier-parallel-reservations-'));
  t.after(async () => { assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir())); await fs.rm(dataDir, { recursive: true, force: true }); });
  const pages = new Map(Object.entries(targets).map(([owner, targetId]) => [targetId, { targetId, owner, url: 'https://www.pixiv.net/', fields: new Map() }]));
  const remote = new Map([['101', []], ['202', []]]), uploads = [], clicks = [], closed = [], events = [];
  let sequence = 0;
  function scope(onlyOwner = null) {
    let selected;
    const allowed = value => value && (!onlyOwner || value.owner === onlyOwner);
    const page = () => { const value = pages.get(selected); assert.ok(allowed(value), 'selected page must belong to this browser'); return value; };
    return {
      fork: () => scope(onlyOwner),
      tabs: async () => [...pages.values()].filter(allowed).map(({ targetId, url }) => ({ targetId, url })),
      select: async targetId => { assert.ok(allowed(pages.get(targetId))); selected = targetId; },
      openTab: async url => {
        const owner = page().owner, targetId = options.reuseBound ? targets[owner] : (++sequence).toString(16).padStart(32, '0');
        pages.set(targetId, { targetId, owner, url, fields: new Map(), tags: [] }); selected = targetId;
        return { targetId, url };
      },
      command: async ([action, selector, value]) => {
        if (action === 'tab' && selector === 'close') {
          events.push(`close:${value}`);
          if (options.closeFailure) throw new Error('tab close refused');
          assert.ok(allowed(pages.get(value))); closed.push(value); pages.delete(value); return { closed: true, targetId: value };
        }
        const current = page();
        if (action === 'fill' && selector === 'input[placeholder="标签"]') current.tags.push(value);
        else if (['fill', 'check', 'uncheck'].includes(action)) {
          const name = /name="([^"]+)"/.exec(selector)?.[1];
          const radioValue = /value="([^"]+)"/.exec(selector)?.[1];
          current.fields.set(name, { name, ...(action === 'fill' ? { value } : radioValue ? { type: 'radio', value: radioValue, checked: true } : { type: 'checkbox', checked: action === 'check' }) });
        } else if (action === 'upload') {
          uploads.push({ targetId: current.targetId, owner: current.owner, file: value });
          if (options.uploadGate) await options.uploadGate.promise;
          assert.equal(page().targetId, current.targetId, 'another job must not replace the scope cursor');
        }
      },
      evaluate: async (fn, args) => {
        const current = page();
        if (fn.name === 'readIdentity') return { loggedIn: true, pixivUserId: current.owner, premium: true };
        if (fn.name === 'readRemote') {
          assert.equal(current.owner, args.expectedId);
          return { identity: { pixivUserId: current.owner, premium: true }, publicationIndex: { complete: true, pixivUserId: current.owner, artworkIds: [] },
            responses: [{ kind: 'illust', reserved: structuredClone(remote.get(current.owner)) }, { kind: 'novel', reserved: [] }] };
        }
        if (fn.name === 'chooseSchedule') return 'chosen';
        if (fn.name === 'readForm') return { submitEnabled: true, imageCount: 1, fields: [...current.fields.values()], tags: current.tags,
          scheduleLabels: Object.values(scheduleLabels('2026-10-17T00:00:00Z')) };
        if (fn.name === 'clickSubmit') {
          const click = { targetId: current.targetId, owner: current.owner, title: current.fields.get('title').value };
          clicks.push(click); events.push(`submit:${current.targetId}`);
          if (options.onClick) await options.onClick(click, clicks);
          remote.get(current.owner).push({ reserveId: String(1000 + clicks.indexOf(click)), title: click.title, pageCount: 1, releaseDate: '2026-10-17T00:00:00Z' });
          return { clicked: true };
        }
        throw new Error(`Unexpected function ${fn.name}`);
      },
    };
  }
  const dedicatedOptions = options.dedicated ? {
    dedicatedChrome: { ensure: async owner => ({ endpoint: `ws://127.0.0.1:9222/devtools/browser/${owner.id}`, mode: 'headless' }) },
    dedicatedDriverFactory: settings => scope(settings.account.pixivUserId),
    driver: Object.fromEntries(['tabs', 'select', 'openTab', 'command', 'evaluate'].map(name => [name, async () => assert.fail(`Unexpected legacy ${name}`)])),
  } : { driver: scope() };
  const connector = await createBrowserConnector({ dataDir, ...dedicatedOptions, now: () => new Date(NOW) });
  return { connector, pages, remote, uploads, clicks, closed, events, ledger: async () => JSON.parse(await fs.readFile(path.join(dataDir, 'browser-ledger.json'), 'utf8')) };
}

test('two forms upload concurrently, same-account commits are unique and only confirmed owned tabs close', async t => {
  const uploadGate = deferred(), f = await fixture(t, { uploadGate }), owner = account();
  const first = f.connector.reserve(owner, job('first'), ['first.png'], 'first');
  const second = f.connector.reserve(owner, job('second'), ['second.png'], 'second');
  await until(() => f.uploads.length === 2);
  assert.equal(new Set(f.uploads.map(item => item.targetId)).size, 2);
  assert.equal(f.clicks.length, 0);
  uploadGate.resolve();
  const results = await Promise.all([first, second]);
  assert.equal(new Set(results.map(result => result.reservation.remoteId)).size, 2);
  assert.deepEqual(f.events.map(value => value.split(':')[0]), ['submit', 'close', 'submit', 'close']);
  assert.equal(f.closed.length, 2); assert.equal(f.pages.size, 2);
  assert.ok(f.pages.has(targets['101']) && f.pages.has(targets['202']));
  const records = Object.values(await f.ledger());
  assert.equal(records.length, 2); assert.ok(records.every(item => item.phase === 'confirmed' && item.formClosedAt));
  await f.connector.reserve(owner, job('first'), ['first.png'], 'first');
  assert.equal(f.clicks.length, 2, 'successful idempotent retry does not resubmit');
});

test('different Pixiv accounts can commit at the same time without exchanging page data', async t => {
  const gate = deferred(), f = await fixture(t, { onClick: async () => gate.promise });
  const a = account('101'), b = account('202');
  const pending = Promise.all([f.connector.reserve(a, { ...job('a', a), title: 'Account A' }, ['a.png'], 'a'),
    f.connector.reserve(b, { ...job('b', b), title: 'Account B' }, ['b.png'], 'b')]);
  await until(() => f.clicks.length === 2);
  assert.deepEqual(f.clicks.map(item => [item.owner, item.title]).sort(), [['101', 'Account A'], ['202', 'Account B']]);
  gate.resolve();
  assert.ok((await pending).every(item => item.reservation));
  assert.equal(f.closed.length, 2);
});

test('unknown outcome blocks the same Pixiv identity even through another local binding and retains both pages', async t => {
  const uploadGate = deferred(), f = await fixture(t, { uploadGate, onClick: async () => { throw new Error('connection lost after click'); } });
  const a = account(), alias = account('101', 'same-pixiv-alias');
  const pending = [f.connector.reserve(a, job('first', a), ['first.png'], 'unknown'), f.connector.reserve(alias, job('second', alias), ['second.png'], 'blocked')];
  await until(() => f.uploads.length === 2); uploadGate.resolve();
  const results = await Promise.all(pending);
  assert.equal(results.filter(item => !item.definitive).length, 1);
  assert.equal(results.filter(item => item.paused && item.outcome === 'not_uploaded').length, 1);
  assert.equal(f.clicks.length, 1); assert.equal(f.closed.length, 0); assert.equal(f.pages.size, 4);
  assert.deepEqual(Object.values(await f.ledger()).map(item => item.phase).sort(), ['not_submitted', 'unknown']);
});

test('tab cleanup failure never downgrades a confirmed reservation or retries its click', async t => {
  const f = await fixture(t, { closeFailure: true }), owner = account(), work = job('cleanup');
  const result = await f.connector.reserve(owner, work, ['file.png'], 'cleanup');
  assert.ok(result.reservation); assert.equal(f.clicks.length, 1);
  const record = Object.values(await f.ledger())[0];
  assert.equal(record.phase, 'confirmed'); assert.match(record.formCloseError, /close refused/);
  await f.connector.reserve(owner, work, ['file.png'], 'cleanup');
  assert.equal(f.clicks.length, 1);
});

test('an existing user tab returned by a legacy driver is never automatically closed', async t => {
  const f = await fixture(t, { reuseBound: true });
  assert.ok((await f.connector.reserve(account(), job('existing'), ['file.png'], 'existing')).reservation);
  assert.equal(f.closed.length, 0); assert.ok(f.pages.has(targets['101']));
});

test('capacity filled while two forms prepare is rechecked before the next commit', async t => {
  const uploadGate = deferred(), f = await fixture(t, { uploadGate }), owner = account();
  const pending = [f.connector.reserve(owner, job('one'), ['one.png'], 'one'), f.connector.reserve(owner, job('two'), ['two.png'], 'two')];
  await until(() => f.uploads.length === 2);
  for (let index = 0; index < 9; index++) f.remote.get('101').push({ reserveId: String(index), title: 'Other work', pageCount: 1, releaseDate: '2026-10-17T00:00:00Z' });
  uploadGate.resolve();
  const results = await Promise.all(pending);
  assert.equal(f.clicks.length, 1); assert.equal(f.remote.get('101').length, 10);
  assert.equal(results.filter(item => item.reservation).length, 1);
  assert.ok(results.some(item => item.outcome === 'not_uploaded' && item.capacityBlocked === true && /名额已满/.test(item.error)));
  assert.equal(f.closed.length, 1, 'only the successful form closes');
});

test('dedicated account drivers prepare and submit concurrently within their own profile', async t => {
  const gate = deferred(), f = await fixture(t, { dedicated: true, onClick: async () => gate.promise });
  const a = account('101'), b = account('202');
  a.browser = { ...a.browser, mode: 'dedicated', targetId: null };
  b.browser = { ...b.browser, mode: 'dedicated', targetId: 'F'.repeat(32) };
  const pending = Promise.all([f.connector.reserve(a, { ...job('a', a), title: 'Account A' }, ['a.png'], 'a'),
    f.connector.reserve(b, { ...job('b', b), title: 'Account B' }, ['b.png'], 'b')]);
  await until(() => f.clicks.length === 2);
  assert.deepEqual(f.clicks.map(item => [item.owner, item.title]).sort(), [['101', 'Account A'], ['202', 'Account B']]);
  gate.resolve();
  assert.ok((await pending).every(item => item.reservation));
  assert.equal(f.closed.length, 2);
  assert.ok(f.pages.has(targets['101']) && f.pages.has(targets['202']));
  assert.equal(a.browser.targetId, null); assert.equal(b.browser.targetId, 'F'.repeat(32));
});

test('dedicated profiles bound to the same Pixiv account share the unknown-outcome commit barrier', async t => {
  const uploadGate = deferred(), f = await fixture(t, { dedicated: true, uploadGate,
    onClick: async () => { throw new Error('connection lost after click'); } });
  const a = account(), alias = account('101', 'same-pixiv-alias');
  a.browser.mode = alias.browser.mode = 'dedicated';
  const pending = [f.connector.reserve(a, job('first', a), ['first.png'], 'unknown'),
    f.connector.reserve(alias, job('second', alias), ['second.png'], 'blocked')];
  await until(() => f.uploads.length === 2); uploadGate.resolve();
  const results = await Promise.all(pending);
  assert.equal(results.filter(item => !item.definitive).length, 1);
  assert.equal(results.filter(item => item.paused && item.outcome === 'not_uploaded').length, 1);
  assert.equal(f.clicks.length, 1); assert.equal(f.closed.length, 0);
  assert.deepEqual(Object.values(await f.ledger()).map(item => item.phase).sort(), ['not_submitted', 'unknown']);
});
