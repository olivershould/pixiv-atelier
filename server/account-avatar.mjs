import * as http from 'node:http';

const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const AVATAR_TIMEOUT_MS = 15000;
let environmentProxyConfigured = false;

// Profile images only: no arbitrary Pixiv URL, credentials, port, query,
// fragment, escaped path or redirect can become a request through this proxy.
export function normalizeAvatarUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || value.trim() !== value) return '';
  if (!/^https:\/\/i\.pximg\.net\/(?:user-profile\/(?:[a-z0-9_-]+\/)*[a-z0-9_-]+\.(?:jpe?g|png|webp|gif)|common\/images\/no_profile(?:[_-][a-z0-9_-]+)?\.(?:jpe?g|png|webp|gif))$/i.test(value)) return '';
  return value.replace(/^https:\/\/i\.pximg\.net/i, 'https://i.pximg.net');
}

// Serialized directly into the already identity-verified Pixiv tab. Keep this
// function self-contained; cookies and the complete profile never leave Chrome.
export async function readAccountAvatar({ expectedId }) {
  if (location.origin !== 'https://www.pixiv.net' || typeof expectedId !== 'string' || !/^\d{1,20}$/.test(expectedId)) {
    throw new Error('无法核对 Pixiv 账号头像。');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`/ajax/user/${expectedId}?full=1`, {
      method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
    });
    if (!response.ok) throw new Error('无法读取 Pixiv 账号头像。');
    const json = await response.json();
    const body = json?.body;
    // If either identity field is present it must agree with the binding.
    const ids = [body?.userId, body?.id].filter(id => id !== undefined && id !== null).map(String);
    if (json?.error || ids.length === 0 || ids.some(id => id !== expectedId)) {
      throw new Error('Pixiv 头像资料与绑定账号不一致。');
    }
    // Same allowlist as normalizeAvatarUrl, repeated because this function is
    // transported without its module closure. Tests verify both boundaries.
    const avatarUrl = [body.imageBig, body.image].find(value => typeof value === 'string' && value.length <= 2048 && value.trim() === value &&
      /^https:\/\/i\.pximg\.net\/(?:user-profile\/(?:[a-z0-9_-]+\/)*[a-z0-9_-]+\.(?:jpe?g|png|webp|gif)|common\/images\/no_profile(?:[_-][a-z0-9_-]+)?\.(?:jpe?g|png|webp|gif))$/i.test(value));
    return { pixivUserId: expectedId, avatarUrl: (avatarUrl || '').replace(/^https:\/\/i\.pximg\.net/i, 'https://i.pximg.net') };
  } catch (error) {
    // Do not pass browser/network error messages containing response data on.
    if (error?.message === 'Pixiv 头像资料与绑定账号不一致。') throw error;
    throw new Error('无法读取 Pixiv 账号头像。');
  } finally {
    clearTimeout(timer);
  }
}

function avatarError() {
  const error = new Error('暂时无法显示 Pixiv 账号头像。');
  error.code = 'avatar_unavailable';
  error.status = 502;
  return error;
}

function detectedContentType(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return '';
}

export async function fetchAvatar(url, { fetchImpl = globalThis.fetch } = {}) {
  const safeUrl = normalizeAvatarUrl(url);
  if (!safeUrl) throw avatarError();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AVATAR_TIMEOUT_MS);
  let reader;
  try {
    // Current Node versions can use the desktop's existing HTTPS proxy without
    // another dependency. Keep every local connector on the loopback network.
    if (fetchImpl === globalThis.fetch && !environmentProxyConfigured) {
      if (typeof http.setGlobalProxyFromEnv === 'function') {
        const noProxy = [process.env.no_proxy || process.env.NO_PROXY, 'localhost', '127.0.0.1', '::1', '[::1]'].filter(Boolean).join(',');
        http.setGlobalProxyFromEnv({ ...process.env, no_proxy: noProxy, NO_PROXY: noProxy });
      }
      environmentProxyConfigured = true;
    }
    const response = await fetchImpl(safeUrl, {
      method: 'GET', redirect: 'error', credentials: 'omit', signal: controller.signal,
      headers: { Referer: 'https://www.pixiv.net/', Accept: 'image/png,image/jpeg,image/webp,image/gif' },
    });
    if (!response.ok || response.redirected || (response.url && normalizeAvatarUrl(response.url) !== safeUrl)) throw avatarError();
    const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(contentType)) throw avatarError();
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_AVATAR_BYTES)) throw avatarError();
    if (!response.body?.getReader) throw avatarError();
    reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_AVATAR_BYTES) throw avatarError();
      chunks.push(Buffer.from(value));
    }
    const bytes = Buffer.concat(chunks, size);
    if (detectedContentType(bytes) !== contentType) throw avatarError();
    return { bytes, contentType };
  } catch {
    controller.abort();
    try { await reader?.cancel(); } catch {}
    throw avatarError();
  } finally {
    clearTimeout(timer);
    try { reader?.releaseLock(); } catch {}
  }
}
