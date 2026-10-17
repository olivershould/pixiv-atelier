import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeArtworkThumbnail, fetchArtworkThumbnail } from '../server/artwork-thumbnail.mjs';

const artworkId = '123456789';
const thumbnailUrl = `https://i.pximg.net/c/250x250_80_a2/img-master/img/2026/01/02/03/04/05/${artworkId}_p0_square1200.jpg`;
const source = { artworkId, thumbnailUrl };
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const unsafeUrls = [
  thumbnailUrl.replace('https:', 'http:'), thumbnailUrl.replace('i.pximg.net', 'i.pximg.net.attacker.test'),
  thumbnailUrl.replace('i.pximg.net', 'sub.i.pximg.net'), thumbnailUrl.replace('i.pximg.net', 'name:secret@i.pximg.net'),
  thumbnailUrl.replace('i.pximg.net', 'i.pximg.net:443'), `${thumbnailUrl}?secret=token`, `${thumbnailUrl}#fragment`,
  thumbnailUrl.replace('/c/250x250_80_a2', ''), thumbnailUrl.replace('250x250', '361x250'), thumbnailUrl.replace('250x250', '250x400'),
  thumbnailUrl.replace('250x250', '0x250'), thumbnailUrl.replace('img-master', 'img-original'),
  thumbnailUrl.replace('_square1200', ''), thumbnailUrl.replace('_square1200', '_custom1200'),
  thumbnailUrl.replace('/img/2026', '/img/../2026'), thumbnailUrl.replace('/img/2026', '/img/%2e%2e/2026'),
  thumbnailUrl.replace('/img/2026', '\\img\\2026'), thumbnailUrl.replace('.jpg', '.svg'),
  ` ${thumbnailUrl}`, `${thumbnailUrl}\n`, `data:image/png;base64,secret`, 'https://127.0.0.1/a.jpg', null, {}, 'x'.repeat(2049),
];

test('thumbnail URL allowlist enforces the artwork identity and bounded Pixiv CDN thumbnail paths', () => {
  assert.equal(normalizeArtworkThumbnail(thumbnailUrl, artworkId), thumbnailUrl);
  const custom = thumbnailUrl.replace('250x250_80_a2', '360x360_70').replace('img-master', 'custom-thumb').replace('square1200', 'custom1200');
  assert.equal(normalizeArtworkThumbnail(custom, artworkId), custom);
  assert.equal(normalizeArtworkThumbnail(thumbnailUrl.replace('https://i.pximg.net', 'HTTPS://I.PXIMG.NET'), artworkId), thumbnailUrl);
  assert.equal(normalizeArtworkThumbnail(thumbnailUrl, '987654321'), '');
  for (const id of ['', '../bad', null, 123456789, '1'.repeat(21)]) assert.equal(normalizeArtworkThumbnail(thumbnailUrl, id), '');
  for (const value of unsafeUrls) assert.equal(normalizeArtworkThumbnail(value, artworkId), '', String(value));
});

test('thumbnail fetch sends no credentials and only fixed image headers', async () => {
  let called = 0;
  const result = await fetchArtworkThumbnail(source, { fetchImpl: async (url, options) => {
    called++;
    assert.equal(url, thumbnailUrl);
    assert.equal(options.method, 'GET');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Referer, 'https://www.pixiv.net/');
    assert.deepEqual(Object.keys(options.headers).sort(), ['Accept', 'Referer']);
    return new Response(png, { headers: { 'Content-Type': 'image/png' } });
  } });
  assert.equal(called, 1);
  assert.deepEqual(result, { bytes: png, contentType: 'image/png' });
});

test('unsafe and mismatched artwork sources fail before any network request', async () => {
  let calls = 0;
  for (const url of [...unsafeUrls, thumbnailUrl.replace(artworkId, '987654321')]) {
    await assert.rejects(fetchArtworkThumbnail({ artworkId, thumbnailUrl: url }, { fetchImpl: () => { calls++; } }), { code: 'artwork_thumbnail_unavailable', status: 502 });
  }
  assert.equal(calls, 0);
});

test('thumbnail fetch rejects HTTP errors, redirects, SVG, URL changes and signature mismatches', async () => {
  const failures = [
    new Response('secret', { status: 403 }), new Response('secret', { status: 302, headers: { Location: 'https://attacker.test/' } }),
    new Response('<svg></svg>', { headers: { 'Content-Type': 'image/svg+xml' } }),
    new Response('<svg></svg>', { headers: { 'Content-Type': 'image/png' } }),
    new Response(png, { headers: { 'Content-Type': 'image/jpeg' } }),
    new Response(png, { headers: { 'Content-Type': 'image/png', 'Content-Length': '-1' } }),
    { ok: true, redirected: true }, { ok: true, url: 'https://attacker.test/a.jpg' },
    { ok: true, url: thumbnailUrl.replace(artworkId, '987654321') },
  ];
  for (const response of failures) await assert.rejects(fetchArtworkThumbnail(source, { fetchImpl: async () => response }), error =>
    error.code === 'artwork_thumbnail_unavailable' && error.status === 502 && !error.message.includes('secret'));
  await assert.rejects(fetchArtworkThumbnail(source, { fetchImpl: () => { throw new Error('secret network details'); } }), error =>
    error.code === 'artwork_thumbnail_unavailable' && !error.message.includes('secret'));
});

test('thumbnail fetch enforces declared and streamed one MiB limits and cancels oversized streams', async () => {
  await assert.rejects(fetchArtworkThumbnail(source, { fetchImpl: async () => new Response(png, { headers: {
    'Content-Type': 'image/png', 'Content-Length': String(1024 * 1024 + 1),
  } }) }), { code: 'artwork_thumbnail_unavailable' });
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(512 * 1024)); }, cancel() { cancelled = true; },
  });
  await assert.rejects(fetchArtworkThumbnail(source, { fetchImpl: async () => new Response(stream, { headers: { 'Content-Type': 'image/png' } }) }), { code: 'artwork_thumbnail_unavailable' });
  assert.equal(cancelled, true);
});

test('thumbnail fetch accepts only raster bytes matching their declared MIME', async () => {
  for (const [contentType, bytes] of [
    ['image/jpeg', Buffer.from([255, 216, 255, 1])], ['image/gif', Buffer.from('GIF89aexample')], ['image/webp', Buffer.from('RIFF0000WEBPexample')],
  ]) {
    const result = await fetchArtworkThumbnail(source, { fetchImpl: async () => new Response(bytes, { headers: { 'Content-Type': `${contentType}; charset=binary` } }) });
    assert.equal(result.contentType, contentType); assert.deepEqual(result.bytes, bytes);
  }
});

test('thumbnail timeout bounds a fetch even when its implementation ignores abort', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const pending = fetchArtworkThumbnail(source, { fetchImpl: (_url, options) => { signal = options.signal; return new Promise(() => {}); } });
  const assertion = assert.rejects(pending, { code: 'artwork_thumbnail_unavailable', status: 502 });
  t.mock.timers.tick(10000);
  await assertion;
  assert.equal(signal.aborted, true);
});

test('thumbnail timeout also bounds a stalled body after headers have arrived', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let cancelled = false, reading;
  const started = new Promise(resolve => { reading = resolve; });
  const pending = fetchArtworkThumbnail(source, { fetchImpl: async () => ({ ok: true, headers: new Headers({ 'Content-Type': 'image/png' }), body: { getReader: () => ({
    read: () => { reading(); return new Promise(() => {}); }, cancel: () => { cancelled = true; }, releaseLock() {},
  }) } }) });
  await started;
  const assertion = assert.rejects(pending, { code: 'artwork_thumbnail_unavailable' });
  t.mock.timers.tick(10000);
  await assertion;
  assert.equal(cancelled, true);
});
