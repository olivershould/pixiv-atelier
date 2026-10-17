import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBrowserConnector } from '../server/browser-connector.mjs';

const target = number => number.toString(16).padStart(32, '0');
const account = (id = '101', extra = {}) => ({ id: `local-${id}`, pixivUserId: id,
  browser: { mode: 'dedicated', targetId: null, postingEnabled: false, loginPending: true, ...extra } });
const remote = id => ({ identity: { pixivUserId: id, premium: true },
  publicationIndex: { complete: true, pixivUserId: id, artworkIds: [] },
  responses: [{ kind: 'illust', reserved: [] }, { kind: 'novel', reserved: [] }] });

async function fixture(t, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'atelier-dedicated-browser-'));
  const profiles = new Map(), instances = [], events = [], legacyCalls = [];
  let sequence = 10;
  function profile(id) {
    if (!profiles.has(id)) profiles.set(id, { id, identity: id, loggedIn: true, mode: 'headless', version: 1,
      pages: new Map([[target(++sequence), 'https://www.pixiv.net/dashboard/works']]) });
    return profiles.get(id);
  }
  function info(account) {
    const value = profile(account.pixivUserId);
    return { endpoint: `ws://127.0.0.1:9222/devtools/browser/${value.id}-${value.version}`,
      userDataDir: path.join(dataDir, 'profiles', account.id), mode: value.mode };
  }
  function restart(value, mode) {
    value.mode = mode; value.version++;
    value.pages = new Map([[target(++sequence), 'https://www.pixiv.net/dashboard/works']]);
  }
  const manager = {
    ensure: async owner => { events.push(`ensure:${owner.pixivUserId}`); return info(owner); },
    showLogin: async owner => { events.push(`open:${owner.pixivUserId}`); restart(profile(owner.pixivUserId), 'interactive'); return info(owner); },
    finishLogin: async owner => {
      events.push(`background:${owner.pixivUserId}`); const value = profile(owner.pixivUserId); restart(value, 'headless');
      if (options.identityAfterBackground) value.identity = options.identityAfterBackground;
      return info(owner);
    },
  };
  const legacy = Object.fromEntries(['tabs', 'select', 'openTab', 'command', 'evaluate'].map(name => [name, async () => {
    legacyCalls.push(name); throw new Error('Dedicated work must not touch the legacy Chrome');
  }]));
  legacy.close = () => {};
  function factory(settings) {
    assert.equal(settings.dedicated, true);
    const value = profile(settings.account.pixivUserId);
    const instance = { id: value.id, closed: false, connected: false, cursors: [], settings,
      disconnect() { this.connected = false; } };
    instances.push(instance);
    async function connect() {
      assert.equal(instance.closed, false);
      if (!instance.connected) { instance.endpoint = await settings.endpoint(); instance.connected = true; }
    }
    function scope(root = false) {
      const cursor = { selected: null, released: false };
      instance.cursors.push(cursor);
      async function ready() { assert.equal(cursor.released, false); await connect(); }
      function selected() { assert.ok(value.pages.has(cursor.selected)); return cursor.selected; }
      return {
        fork: () => scope(),
        close: () => { if (root) { instance.closed = true; events.push(`close:${value.id}`); } else cursor.released = true; },
        tabs: async () => { await ready(); return [...value.pages].map(([targetId, url]) => ({ targetId, url })); },
        select: async targetId => { await ready(); assert.ok(value.pages.has(targetId)); cursor.selected = targetId; },
        openTab: async url => {
          await ready(); const targetId = target(++sequence); value.pages.set(targetId, url); cursor.selected = targetId;
          events.push(`newtab:${value.id}`); return { targetId, url };
        },
        command: async () => { await ready(); selected(); },
        evaluate: async (fn, args) => {
          await ready(); selected(); events.push(`${fn.name}:${value.id}`);
          if (fn.name === 'readDedicatedIdentity') return { loggedIn: value.loggedIn, pixivUserId: value.identity };
          if (fn.name === 'readRemote') return remote(value.identity);
          if (fn.name === 'readAccountAvatar') return null;
          if (fn.name === 'readTags') {
            assert.equal(args.expectedId, value.id);
            return { pixivUserId: value.identity, matches: [], recentWorks: [], frequentTags: [] };
          }
          if (fn.name === 'readAnalyticsOverview') return { pixivUserId: value.id, artworks: [], account: null, index: null,
            complete: value.identity === value.id, errors: value.identity === value.id ? [] : [{ phase: 'identity', code: 'identity_mismatch' }] };
          throw new Error(`Unexpected browser function ${fn.name}`);
        },
      };
    }
    return scope(true);
  }
  const connector = await createBrowserConnector({ dataDir, driver: legacy, dedicatedChrome: options.withoutManager ? undefined : manager,
    dedicatedDriverFactory: factory, now: () => new Date('2026-10-16T00:00:00Z') });
  t.after(async () => {
    await connector.close(); assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir()));
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return { connector, profile, instances, events, legacyCalls, manager };
}

test('dedicated accounts reuse separate drivers and never fall back to the legacy connection', async t => {
  const f = await fixture(t), a = account(), b = account('202');
  const results = await Promise.all([f.connector.snapshot(a), f.connector.snapshot(b)]);
  assert.deepEqual(results.map(value => value.pixivUserId), ['101', '202']);
  await f.connector.snapshot(a);
  await f.connector.searchTags(b, ['example']);
  await f.connector.analytics(a, { includeAccount: true });
  assert.deepEqual(f.instances.map(value => value.id), ['101', '202']);
  assert.deepEqual(f.events.filter(value => value.startsWith('ensure:')), ['ensure:101', 'ensure:202']);
  assert.ok(f.instances.every(value => !value.closed));
  assert.ok(f.instances.every(value => value.cursors.slice(1).every(cursor => cursor.released)));
  assert.deepEqual(f.legacyCalls, []);
});

test('dedicated verification resolves stale or absent targets and excludes retained submission forms', async t => {
  const f = await fixture(t), owner = account('101', { targetId: target(999), postingEnabled: true });
  const p = f.profile('101'), original = structuredClone(owner);
  p.pages = new Map([[target(5), 'https://www.pixiv.net/illustration/create'], [target(6), 'https://www.pixiv.net/manga/create']]);
  const first = await f.connector.verifyDedicated(owner);
  assert.equal(first.account.pixivUserId, owner.pixivUserId);
  assert.equal(first.account.browser.postingEnabled, false);
  assert.equal(first.account.browser.loginPending, false);
  assert.equal(first.account.browser.runtimeMode, 'headless');
  assert.ok(![target(5), target(6), owner.browser.targetId].includes(first.account.browser.targetId));
  assert.deepEqual(owner, original, 'verification must not mutate the persisted input');
  assert.equal(p.pages.get(target(5)), 'https://www.pixiv.net/illustration/create');
  p.pages = new Map([[target(77), 'https://www.pixiv.net/dashboard/works']]);
  f.instances[0].disconnect();
  const second = await f.connector.verifyDedicated(first.account);
  assert.equal(second.account.browser.targetId, target(77));
  assert.equal(f.instances.length, 1);
  assert.equal(f.events.filter(value => value === 'ensure:101').length, 2, 'a reconnect must resolve the managed endpoint again');
  assert.deepEqual(f.legacyCalls, []);
});

test('logged out and wrong-account profiles cannot verify, collect, or replace the expected Pixiv identity', async t => {
  const f = await fixture(t), owner = account(), p = f.profile('101');
  p.loggedIn = false;
  await assert.rejects(f.connector.verifyDedicated(owner), { code: 'login_required' });
  p.loggedIn = true; p.identity = '999';
  await assert.rejects(f.connector.verifyDedicated(owner), { code: 'identity_mismatch' });
  await assert.rejects(f.connector.snapshot(owner), { code: 'identity_mismatch' });
  await assert.rejects(f.connector.analytics(owner, { includeAccount: true }), { code: 'identity_mismatch' });
  await assert.rejects(f.connector.backgroundDedicated(owner), { code: 'identity_mismatch' });
  assert.equal(f.events.includes('background:101'), false, 'wrong account must be rejected before changing runtime mode');
  assert.equal(owner.pixivUserId, '101'); assert.equal(owner.browser.loginPending, true);
  assert.deepEqual(f.legacyCalls, []);
});

test('login and background transitions release only their account driver and reverify the new process', async t => {
  const f = await fixture(t), a = account(), b = account('202');
  await Promise.all([f.connector.snapshot(a), f.connector.snapshot(b)]);
  const originalA = f.instances[0], originalB = f.instances[1];
  const opened = await f.connector.openDedicatedLogin(a);
  assert.deepEqual(opened, { mode: 'interactive', loginPending: true });
  assert.equal(originalA.closed, true); assert.equal(originalB.closed, false);
  const interactive = await f.connector.verifyDedicated(a);
  assert.equal(interactive.account.browser.runtimeMode, 'interactive');
  const interactiveDriver = f.instances.at(-1), before = f.events.length;
  const hidden = await f.connector.backgroundDedicated(interactive.account);
  assert.equal(hidden.account.browser.runtimeMode, 'headless');
  assert.equal(hidden.account.browser.postingEnabled, false);
  assert.notEqual(hidden.account.browser.targetId, interactive.account.browser.targetId);
  assert.equal(interactiveDriver.closed, true); assert.equal(originalB.closed, false);
  const transition = f.events.slice(before), changed = transition.indexOf('background:101');
  assert.ok(transition.indexOf('readDedicatedIdentity:101') < changed);
  assert.ok(transition.lastIndexOf('readDedicatedIdentity:101') > changed);
  await f.connector.snapshot(b);
  assert.deepEqual(f.legacyCalls, []);
});

test('a changed identity after entering background mode fails closed', async t => {
  const f = await fixture(t, { identityAfterBackground: '999' });
  await assert.rejects(f.connector.backgroundDedicated(account()), { code: 'identity_mismatch' });
  assert.equal(f.events.filter(value => value === 'background:101').length, 1);
  assert.equal(f.events.filter(value => value === 'readRemote:101').length, 1, 'only the pre-switch identity may read reservations');
  assert.deepEqual(f.legacyCalls, []);
});

test('missing manager and invalid managed endpoints do not connect to a fallback browser', async t => {
  const unavailable = await fixture(t, { withoutManager: true });
  await assert.rejects(unavailable.connector.snapshot(account()), { code: 'dedicated_unavailable' });
  assert.equal(unavailable.instances.length, 0); assert.deepEqual(unavailable.legacyCalls, []);
  const invalid = await fixture(t);
  invalid.manager.ensure = async () => ({ endpoint: 'ws://example.com/devtools/browser/remote', mode: 'headless' });
  await assert.rejects(invalid.connector.snapshot(account()), { code: 'dedicated_unavailable' });
  assert.equal(invalid.instances.length, 0); assert.deepEqual(invalid.legacyCalls, []);
});
