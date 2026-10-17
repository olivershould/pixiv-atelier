import * as http from 'node:http';

const MAX_THUMBNAIL_BYTES = 1024 * 1024;
const THUMBNAIL_TIMEOUT_MS = 10000;
let environmentProxyConfigured = false;

// Allow only Pixiv's bounded CDN thumbnail variants for this exact artwork.
// Originals, arbitrary paths, credentials, query strings and redirects are not
// accepted. The numeric canvas size must stay at or below 360 px per side.
export function normalizeArtworkThumbnail(value, artworkId) {
  if (typeof artworkId !== 'string' || !/^\d{1,20}$/.test(artworkId)
    || typeof value !== 'string' || value.length > 2048 || value.trim() !== value) return '';
  const match = /^https:\/\/i\.pximg\.net\/c\/(\d{1,3})x(\d{1,3})_(?:[1-9]\d?|100)(?:_a2)?\/(img-master|custom-thumb)\/img\/\d{4}(?:\/\d{2}){5}\/(\d{1,20})_p\d{1,3}_(square1200|master1200|custom1200)\.(?:jpe?g|png|webp|gif)$/i.exec(value);
  if (!match || Number(match[1]) < 1 || Number(match[1]) > 360 || Number(match[2]) < 1 || Number(match[2]) > 360
    || match[4] !== artworkId || (match[3].toLowerCase() === 'custom-thumb') !== (match[5].toLowerCase() === 'custom1200')) return '';
  return value.replace(/^https:\/\/i\.pximg\.net/i, 'https://i.pximg.net');
}

function thumbnailError() {
  return Object.assign(new Error('暂时无法显示作品缩略图。'), { code: 'artwork_thumbnail_unavailable', status: 502 });
}

function detectedContentType(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return '';
}

export async function fetchArtworkThumbnail(source, { fetchImpl = globalThis.fetch } = {}) {
  const safeUrl = normalizeArtworkThumbnail(source?.thumbnailUrl, source?.artworkId);
  if (!safeUrl) throw thumbnailError();
  const controller = new AbortController();
  const interrupted = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(thumbnailError()), { once: true }));
  interrupted.catch(() => {});
  const timer = setTimeout(() => controller.abort(), THUMBNAIL_TIMEOUT_MS);
  const bounded = promise => Promise.race([promise, interrupted]);
  let reader;
  try {
    if (fetchImpl === globalThis.fetch && !environmentProxyConfigured) {
      if (typeof http.setGlobalProxyFromEnv === 'function') {
        const noProxy = [process.env.no_proxy || process.env.NO_PROXY, 'localhost', '127.0.0.1', '::1', '[::1]'].filter(Boolean).join(',');
        http.setGlobalProxyFromEnv({ ...process.env, no_proxy: noProxy, NO_PROXY: noProxy });
      }
      environmentProxyConfigured = true;
    }
    const response = await bounded(fetchImpl(safeUrl, {
      method: 'GET', redirect: 'error', credentials: 'omit', signal: controller.signal,
      headers: { Referer: 'https://www.pixiv.net/', Accept: 'image/png,image/jpeg,image/webp,image/gif' },
    }));
    if (!response.ok || response.redirected || (response.url && normalizeArtworkThumbnail(response.url, source.artworkId) !== safeUrl)) throw thumbnailError();
    const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(contentType)) throw thumbnailError();
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_THUMBNAIL_BYTES)) throw thumbnailError();
    if (!response.body?.getReader) throw thumbnailError();
    reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await bounded(reader.read());
      if (done) break;
      size += value.byteLength;
      if (size > MAX_THUMBNAIL_BYTES) throw thumbnailError();
      chunks.push(Buffer.from(value));
    }
    const bytes = Buffer.concat(chunks, size);
    if (detectedContentType(bytes) !== contentType) throw thumbnailError();
    return { bytes, contentType };
  } catch {
    controller.abort();
    try { Promise.resolve(reader?.cancel()).catch(() => {}); } catch {}
    throw thumbnailError();
  } finally {
    clearTimeout(timer);
    try { reader?.releaseLock(); } catch {}
  }
}
