import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { normalizeAvatarUrl, readAccountAvatar, fetchAvatar } from '../server/account-avatar.mjs';

const avatarUrl = 'https://i.pximg.net/user-profile/img/2026/10/13/01/02/03/12345678_170.jpg';
const pngUrl = 'https://i.pximg.net/common/images/no_profile.png';
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const unsafeUrls = [
  'http://i.pximg.net/user-profile/img/a.png',
  'https://i.pximg.net.attacker.test/user-profile/img/a.png',
  'https://sub.i.pximg.net/user-profile/img/a.png',
  'https://www.pixiv.net/user-profile/img/a.png',
  'https://name:secret@i.pximg.net/user-profile/img/a.png',
  'https://i.pximg.net:443/user-profile/img/a.png',
  'https://i.pximg.net/user-profile/img/a.png?secret=token',
  'https://i.pximg.net/user-profile/img/a.png#fragment',
  'https://i.pximg.net/user-profile/img/../../img-original/a.png',
  'https://i.pximg.net/user-profile/img/%2e%2e/a.png',
  'https://i.pximg.net/user-profile\\img\\a.png',
  'https://i.pximg.net/img-original/a.png',
  'https://i.pximg.net/common/images/other.png',
  'https://i.pximg.net/common/images/no_profile.svg',
  'https://i.pximg.net/user-profile/img/a.svg',
  ' https://i.pximg.net/user-profile/img/a.png',
  'https://i.pximg.net/user-profile/img/a.png\n',
  'data:image/png;base64,c2VjcmV0',
  null, {}, 'x'.repeat(2049),
];

function profileFixture({ body = { userId: '101', imageBig: avatarUrl, image: pngUrl }, error = false, origin = 'https://www.pixiv.net', failure, ok = true } = {}) {
  const requests = [];
  const context = vm.createContext({
    location: { origin }, AbortController, setTimeout, clearTimeout,
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (failure) throw failure;
      return { ok, json: async () => ({ error, body }) };
    },
  });
  const read = args => vm.runInContext(`(${readAccountAvatar.toString()})(${JSON.stringify({ expectedId: '101', ...args })})`, context);
  return { requests, read };
}

test('avatar URLs accept only direct profile images and Pixiv default profiles', () => {
  assert.equal(normalizeAvatarUrl(avatarUrl), avatarUrl);
  assert.equal(normalizeAvatarUrl(pngUrl), pngUrl);
  assert.equal(normalizeAvatarUrl('HTTPS://I.PXIMG.NET/common/images/no_profile_s.png'), 'https://i.pximg.net/common/images/no_profile_s.png');
  for (const value of unsafeUrls) assert.equal(normalizeAvatarUrl(value), '', `Unexpected allowed value: ${String(value)}`);
});

test('serialized profile reader returns only verified account ID and large avatar URL', async () => {
  const fixture = profileFixture({ body: { userId: 101, imageBig: avatarUrl, image: pngUrl, name: 'Private name', token: 'secret', privateProfile: {} } });
  assert.deepEqual(JSON.parse(JSON.stringify(await fixture.read())), { pixivUserId: '101', avatarUrl });
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.requests[0].url, '/ajax/user/101?full=1');
  assert.equal(fixture.requests[0].options.method, 'GET');
  assert.equal(fixture.requests[0].options.credentials, 'same-origin');
  assert.equal(fixture.requests[0].options.redirect, 'error');
  assert.equal(fixture.requests[0].options.cache, 'no-store');
});

test('profile reader accepts an id field and falls back to a safe small/default avatar', async () => {
  const result = await profileFixture({ body: { id: '101', imageBig: 'https://attacker.test/a.jpg', image: pngUrl } }).read();
  assert.equal(result.avatarUrl, pngUrl);
  assert.equal(result.pixivUserId, '101');
  for (const url of unsafeUrls) {
    const rejected = await profileFixture({ body: { id: '101', imageBig: url } }).read();
    assert.equal(rejected.avatarUrl, '');
  }
});

test('profile reader rejects cross-account, conflicting or missing identity', async () => {
  for (const body of [{ userId: '202' }, { id: '202' }, { userId: '101', id: '202' }, {}, null]) {
    await assert.rejects(profileFixture({ body: { ...body, imageBig: avatarUrl } }).read(), /绑定账号不一致/);
  }
  await assert.rejects(profileFixture({ error: true }).read(), /绑定账号不一致/);
});

test('profile reader performs no fetch outside Pixiv or with malformed account IDs', async () => {
  const outside = profileFixture({ origin: 'https://attacker.test' });
  await assert.rejects(outside.read(), /无法核对/);
  assert.equal(outside.requests.length, 0);
  const fixture = profileFixture();
  for (const expectedId of ['101/secret', '101?token=secret', '', '1'.repeat(21), 101, null]) {
    await assert.rejects(fixture.read({ expectedId }), /无法核对/);
  }
  assert.equal(fixture.requests.length, 0);
});

test('profile reader does not leak network error text or HTTP failure data', async () => {
  await assert.rejects(profileFixture({ failure: new Error('secret cookie or response contents') }).read(), error => error.message === '无法读取 Pixiv 账号头像。');
  await assert.rejects(profileFixture({ ok: false }).read(), error => error.message === '无法读取 Pixiv 账号头像。');
});

test('avatar proxy streams image bytes with no credentials and a fixed Pixiv referer', async () => {
  let called = 0;
  const result = await fetchAvatar(pngUrl, { fetchImpl: async (url, options) => {
    called++;
    assert.equal(url, pngUrl);
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.Referer, 'https://www.pixiv.net/');
    assert.deepEqual(Object.keys(options.headers).sort(), ['Accept', 'Referer']);
    return new Response(png, { headers: { 'Content-Type': 'image/png' } });
  } });
  assert.equal(called, 1);
  assert.deepEqual(result, { bytes: png, contentType: 'image/png' });
});

test('avatar proxy blocks unsafe URLs before issuing any request', async () => {
  let calls = 0;
  for (const url of unsafeUrls) await assert.rejects(fetchAvatar(url, { fetchImpl: () => { calls++; } }), { code: 'avatar_unavailable', status: 502 });
  assert.equal(calls, 0);
});

test('avatar proxy rejects HTTP errors, redirects, SVG and mismatched raster signatures', async () => {
  const failures = [
    new Response('secret', { status: 403 }),
    new Response('secret', { status: 302, headers: { Location: 'https://attacker.test/' } }),
    new Response('<svg></svg>', { headers: { 'Content-Type': 'image/svg+xml' } }),
    new Response('<svg></svg>', { headers: { 'Content-Type': 'image/png' } }),
    new Response(png, { headers: { 'Content-Type': 'image/jpeg' } }),
    new Response(png, { headers: { 'Content-Type': 'text/html' } }),
    new Response(png, { headers: { 'Content-Type': 'image/png', 'Content-Length': '-1' } }),
    { ok: true, redirected: true },
    { ok: true, url: 'https://attacker.test/a.jpg' },
  ];
  for (const response of failures) await assert.rejects(fetchAvatar(pngUrl, { fetchImpl: async () => response }), error =>
    error.code === 'avatar_unavailable' && error.status === 502 && !error.message.includes('secret'));
});

test('avatar proxy enforces both declared and actual two MiB size limits', async () => {
  await assert.rejects(fetchAvatar(pngUrl, { fetchImpl: async () => new Response(png, {
    headers: { 'Content-Type': 'image/png', 'Content-Length': String(2 * 1024 * 1024 + 1) },
  }) }), { code: 'avatar_unavailable' });
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(fetchAvatar(pngUrl, { fetchImpl: async () => new Response(stream, { headers: { 'Content-Type': 'image/png' } }) }), { code: 'avatar_unavailable' });
  assert.equal(cancelled, true);
});

test('avatar proxy accepts supported raster types only when bytes agree with MIME type', async () => {
  for (const [contentType, bytes] of [
    ['image/jpeg', Buffer.from([255, 216, 255, 1])],
    ['image/gif', Buffer.from('GIF89aexample')],
    ['image/webp', Buffer.from('RIFF0000WEBPexample')],
  ]) {
    const result = await fetchAvatar(avatarUrl, { fetchImpl: async () => new Response(bytes, { headers: { 'Content-Type': `${contentType}; charset=binary` } }) });
    assert.equal(result.contentType, contentType);
    assert.deepEqual(result.bytes, bytes);
  }
});

test('avatar proxy aborts stalled network requests after its fixed timeout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const pending = fetchAvatar(pngUrl, { fetchImpl: async (_url, options) => {
    signal = options.signal;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('secret timeout diagnostics')), { once: true }));
  } });
  const assertion = assert.rejects(pending, { code: 'avatar_unavailable', status: 502 });
  t.mock.timers.tick(15000);
  await assertion;
  assert.equal(signal.aborted, true);
});
