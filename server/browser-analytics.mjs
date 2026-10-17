// Runs inside the already bound Pixiv tab. Only allow-listed analytics fields
// leave the page; every batch rechecks a freshly fetched logged-in identity.
export async function readArtworkAnalytics({ expectedId, artworkIds }) {
  if (location.origin !== 'https://www.pixiv.net' || !/^\d+$/.test(expectedId)) throw new Error('统计读取账号无效。');
  if (!Array.isArray(artworkIds) || artworkIds.length > 10 || artworkIds.some(id => typeof id !== 'string' || !/^\d+$/.test(id))) throw new Error('统计作品批次无效。');
  const ids = [...new Set(artworkIds)];
  const report = (code, extra = {}) => Object.assign(new Error(code), { analyticsError: { code, ...extra } });
  const parse = text => { try { return JSON.parse(text); } catch { throw report('invalid_json'); } };
  const safeError = (error, phase, artworkId) => ({ phase, ...(error?.analyticsError || { code: error?.name === 'AbortError' ? 'timeout' : 'network_error' }), ...(artworkId ? { artworkId } : {}) });
  async function read(url, timeoutMs = 8000) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal });
      if (!response.ok) {
        const raw = response.headers?.get?.('Retry-After');
        const seconds = raw && /^\d+$/.test(raw) ? Number(raw) : raw && Number.isFinite(Date.parse(raw)) ? Math.ceil((Date.parse(raw) - Date.now()) / 1000) : null;
        throw report('http_error', { httpStatus: response.status, ...(Number.isFinite(seconds) ? { retryAfterSeconds: Math.max(0, Math.min(86400, seconds)) } : {}) });
      }
      return await response.text();
    } catch (error) {
      if (error.analyticsError) throw error;
      throw report(controller.signal.aborted || error?.name === 'AbortError' ? 'timeout' : 'network_error');
    } finally { clearTimeout(timer); }
  }
  try {
    const doc = new DOMParser().parseFromString(await read('/dashboard/works'), 'text/html');
    const props = parse(doc.getElementById('__NEXT_DATA__')?.textContent || '{}').props?.pageProps;
    const state = parse(props?.serverSerializedPreloadedState || '{}');
    if (!props) throw report('schema_changed');
    if (!props.isLoggedIn || String(state.userData?.self?.id || props.gaUserData?.userId || '') !== expectedId) throw report('identity_mismatch');
  } catch (error) {
    return { pixivUserId: expectedId, artworks: [], attemptedArtworkIds: [], failedArtworkIds: [], remainingArtworkIds: ids,
      complete: false, errors: [safeError(error, 'identity')], observedAt: new Date().toISOString() };
  }
  const metric = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const isoDate = value => typeof value === 'string' && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
  // Same allowlist as normalizeArtworkThumbnail, kept self-contained because
  // this reader is serialized into Chrome without its module imports.
  const thumbnail = (value, artworkId) => {
    if (typeof artworkId !== 'string' || !/^\d{1,20}$/.test(artworkId) || typeof value !== 'string' || value.length > 2048 || value.trim() !== value) return '';
    const match = /^https:\/\/i\.pximg\.net\/c\/(\d{1,3})x(\d{1,3})_(?:[1-9]\d?|100)(?:_a2)?\/(img-master|custom-thumb)\/img\/\d{4}(?:\/\d{2}){5}\/(\d{1,20})_p\d{1,3}_(square1200|master1200|custom1200)\.(?:jpe?g|png|webp|gif)$/i.exec(value);
    if (!match || Number(match[1]) < 1 || Number(match[1]) > 360 || Number(match[2]) < 1 || Number(match[2]) > 360
      || match[4] !== artworkId || (match[3].toLowerCase() === 'custom-thumb') !== (match[5].toLowerCase() === 'custom1200')) return '';
    return value.replace(/^https:\/\/i\.pximg\.net/i, 'https://i.pximg.net');
  };
  const artworks = new Array(ids.length), attempted = new Set(), failed = new Set(), errors = [];
  const deadline = Date.now() + 25000;
  let next = 0, rateLimited = false;
  await Promise.all(Array.from({ length: Math.min(2, ids.length) }, async () => {
    while (next < ids.length && !rateLimited && Date.now() < deadline) {
      const index = next++, artworkId = ids[index]; attempted.add(artworkId);
      try {
        const json = parse(await read(`/ajax/illust/${artworkId}`, Math.max(1, Math.min(8000, deadline - Date.now()))));
        const observedAt = new Date().toISOString(), work = json.body;
        if (json.error) throw report('remote_error');
        if (String(work?.id) !== artworkId) throw report('artwork_mismatch');
        if (String(work?.userId) !== expectedId) throw report('owner_mismatch');
        if (work.isReserved === true || work.isDraft === true || ['reserved', 'draft', 'scheduled'].includes(work.status)) throw report('not_published');
        const createDate = isoDate(work.createDate);
        if (!createDate || Date.parse(createDate) > Date.parse(observedAt) || typeof work.title !== 'string' || !Array.isArray(work.tags?.tags)) throw report('schema_changed');
        artworks[index] = { artworkId, userId: expectedId, title: work.title.slice(0, 200), thumbnailUrl: thumbnail(work.urls?.thumb, artworkId),
          tags: [...new Set(work.tags.tags.map(row => row?.tag).filter(tag => typeof tag === 'string' && tag.length > 0 && tag.length <= 100))].slice(0, 10),
          createDate, createDateSource: 'pixiv-artwork-detail', publicationTimeVerified: true,
          viewCount: metric(work.viewCount), bookmarkCount: metric(work.bookmarkCount), likeCount: metric(work.likeCount), observedAt, source: 'pixiv-artwork-detail' };
      } catch (error) {
        failed.add(artworkId); const item = safeError(error, 'detail', artworkId); errors.push(item);
        if (item.httpStatus === 429) rateLimited = true;
      }
    }
  }));
  return { pixivUserId: expectedId, artworks: artworks.filter(Boolean), attemptedArtworkIds: ids.filter(id => attempted.has(id)),
    failedArtworkIds: ids.filter(id => failed.has(id)), remainingArtworkIds: ids.filter(id => !attempted.has(id)),
    complete: attempted.size === ids.length && !failed.size, errors, rateLimited,
    retryAfterSeconds: Math.max(0, ...errors.map(error => error.retryAfterSeconds || 0)), observedAt: new Date().toISOString() };
}

// Index and account overview are separate from per-artwork reads so deadline
// samples need not enumerate a large library every time.
export async function readAnalyticsOverview({ expectedId, includeIndex = false, includeAccount = false }) {
  if (location.origin !== 'https://www.pixiv.net' || !/^\d+$/.test(expectedId)) throw new Error('统计读取账号无效。');
  const report = (code, extra = {}) => Object.assign(new Error(code), { analyticsError: { code, ...extra } });
  const parse = text => { try { return JSON.parse(text); } catch { throw report('invalid_json'); } };
  const safeError = (error, phase) => ({ phase, ...(error?.analyticsError || { code: error?.name === 'AbortError' ? 'timeout' : 'network_error' }) });
  async function read(url) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal });
      if (!response.ok) {
        const raw = response.headers?.get?.('Retry-After');
        const seconds = raw && /^\d+$/.test(raw) ? Number(raw) : raw && Number.isFinite(Date.parse(raw)) ? Math.ceil((Date.parse(raw) - Date.now()) / 1000) : null;
        throw report('http_error', { httpStatus: response.status, ...(Number.isFinite(seconds) ? { retryAfterSeconds: Math.max(0, Math.min(86400, seconds)) } : {}) });
      }
      return await response.text();
    } catch (error) {
      if (error.analyticsError) throw error;
      throw report(controller.signal.aborted || error?.name === 'AbortError' ? 'timeout' : 'network_error');
    } finally { clearTimeout(timer); }
  }
  const result = { pixivUserId: expectedId, artworks: [], index: null, account: null, errors: [], complete: true };
  try {
    const doc = new DOMParser().parseFromString(await read('/dashboard/works'), 'text/html');
    const props = parse(doc.getElementById('__NEXT_DATA__')?.textContent || '{}').props?.pageProps;
    const state = parse(props?.serverSerializedPreloadedState || '{}');
    if (!props) throw report('schema_changed');
    if (!props.isLoggedIn || String(state.userData?.self?.id || props.gaUserData?.userId || '') !== expectedId) throw report('identity_mismatch');
  } catch (error) {
    result.errors.push(safeError(error, 'identity')); result.complete = false;
    return { ...result, observedAt: new Date().toISOString() };
  }
  if (includeIndex) {
    try {
      const json = parse(await read(`/ajax/user/${expectedId}/profile/all?lang=zh`)), body = json.body;
      if (json.error) throw report('remote_error');
      const collection = value => value === null || value && typeof value === 'object' && !Array.isArray(value) || Array.isArray(value) && value.length === 0;
      if (!body || !Object.hasOwn(body, 'illusts') || !Object.hasOwn(body, 'manga') || !collection(body.illusts) || !collection(body.manga)) throw report('schema_changed');
      const artworkIds = [...new Set([...Object.keys(body.illusts || {}), ...Object.keys(body.manga || {})])];
      if (artworkIds.length > 50000 || artworkIds.some(id => !/^\d+$/.test(id))) throw report('schema_changed');
      artworkIds.sort((a, b) => b.length - a.length || b.localeCompare(a));
      result.index = { pixivUserId: expectedId, artworkIds, total: artworkIds.length, complete: true, source: 'pixiv-profile-all', observedAt: new Date().toISOString() };
    } catch (error) { result.errors.push(safeError(error, 'index')); result.complete = false; }
  }
  if (includeAccount && !result.errors.some(error => error.httpStatus === 429)) {
    const reportPath = '/dashboard/report/artworks?graph_term=month';
    result.account = { pixivUserId: expectedId, viewCount: null, followerCount: null, source: {}, observedAt: new Date().toISOString() };
    try {
      const doc = new DOMParser().parseFromString(await read(reportPath), 'text/html');
      result.account.observedAt = new Date().toISOString();
      for (const [field, section, selector] of [['viewCount', 'access', 'a.report-link.section-access']]) {
        try {
          // These top-level report counters are distinct from the chart data.
          // The link explicitly identifies both the metric and its owner.
          const links = [...doc.querySelectorAll(selector)];
          if (links.length !== 1) throw report('schema_changed');
          const url = new URL(links[0].getAttribute('href') || '', 'https://www.pixiv.net');
          if (url.origin !== 'https://www.pixiv.net' || url.searchParams.getAll('user_id').length !== 1
            || url.searchParams.get('user_id') !== expectedId) throw report('identity_mismatch');
          if (url.searchParams.getAll('section').length !== 1 || url.searchParams.get('section') !== section) throw report('schema_changed');
          const counts = [...links[0].querySelectorAll(':scope > div.count')];
          if (counts.length !== 1) throw report('schema_changed');
          const value = counts[0].textContent.trim();
          if (!/^(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)$/.test(value)) throw report('schema_changed');
          const count = Number(value.replaceAll(',', ''));
          if (!Number.isSafeInteger(count) || count < 0) throw report('schema_changed');
          result.account[field] = count;
          result.account.source[field] = { url: `https://www.pixiv.net${reportPath}`, selector: `${selector} > div.count`, section, scope: 'cumulative', surface: 'report-top-summary' };
        } catch (error) { result.errors.push({ ...safeError(error, 'account'), metric: field }); result.complete = false; }
      }
    } catch (error) { result.errors.push({ ...safeError(error, 'account'), metric: 'viewCount' }); result.complete = false; }
    if (!result.errors.some(error => error.httpStatus === 429)) {
      const followersPath = `/ajax/user/${expectedId}/followers?offset=0&limit=24&lang=zh`;
      try {
        // This is the total shown by the owner's followers page. The report's
        // follower counter belongs to a different series and is never a fallback.
        const json = parse(await read(followersPath));
        result.account.observedAt = new Date().toISOString();
        if (!json || typeof json !== 'object' || Array.isArray(json)) throw report('schema_changed');
        if (json.error) throw report('remote_error');
        if (!json.body || typeof json.body !== 'object' || Array.isArray(json.body) || !Object.hasOwn(json.body, 'total')) throw report('metric_missing');
        const total = json.body.total;
        if (!Number.isSafeInteger(total) || total < 0) throw report('schema_changed');
        result.account.followerCount = total;
        result.account.source.followerCount = { seriesId: 'pixiv-followers-page-total-v1',
          url: `https://www.pixiv.net/users/${expectedId}/followers`, endpoint: `https://www.pixiv.net${followersPath}`,
          field: 'body.total', scope: 'current', surface: 'followers-page' };
      } catch (error) { result.errors.push({ ...safeError(error, 'account'), metric: 'followerCount' }); result.complete = false; }
    }
  }
  return { ...result, observedAt: new Date().toISOString() };
}

// These two management routes and their pagination ranges were verified in
// Pixiv's own dashboard. One call reads one page, never thousands of details.
export async function readAnalyticsWorksPage({ expectedId, offset, limit = 1000 }) {
  if (location.origin !== 'https://www.pixiv.net' || !/^\d+$/.test(expectedId)) throw new Error('统计读取账号无效。');
  if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0 || offset > 50000)
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('统计分页参数无效。');
  const initial = offset === undefined;
  const report = (code, extra = {}) => Object.assign(new Error(code), { analyticsError: { code, ...extra } });
  const parse = text => { try { return JSON.parse(text); } catch { throw report('invalid_json'); } };
  const safeError = (error, phase, artworkId) => ({ phase, ...(error?.analyticsError || { code: error?.name === 'AbortError' ? 'timeout' : 'network_error' }), ...(artworkId ? { artworkId } : {}) });
  async function read(url) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal });
      if (!response.ok) {
        const raw = response.headers?.get?.('Retry-After');
        const seconds = raw && /^\d+$/.test(raw) ? Number(raw) : raw && Number.isFinite(Date.parse(raw)) ? Math.ceil((Date.parse(raw) - Date.now()) / 1000) : null;
        throw report('http_error', { httpStatus: response.status, ...(Number.isFinite(seconds) ? { retryAfterSeconds: Math.max(0, Math.min(86400, seconds)) } : {}) });
      }
      return await response.text();
    } catch (error) {
      if (error.analyticsError) throw error;
      throw report(controller.signal.aborted || error?.name === 'AbortError' ? 'timeout' : 'network_error');
    } finally { clearTimeout(timer); }
  }
  const result = { pixivUserId: expectedId, artworks: [], attemptedArtworkIds: [], failedArtworkIds: [], remainingArtworkIds: [],
    errors: [], complete: false, total: null, fetchRanges: null, nextRange: null, page: null, source: 'pixiv-management-bulk' };
  try {
    const doc = new DOMParser().parseFromString(await read('/dashboard/works'), 'text/html');
    const props = parse(doc.getElementById('__NEXT_DATA__')?.textContent || '{}').props?.pageProps;
    const state = parse(props?.serverSerializedPreloadedState || '{}');
    if (!props) throw report('schema_changed');
    if (!props.isLoggedIn || String(state.userData?.self?.id || props.gaUserData?.userId || '') !== expectedId) throw report('identity_mismatch');
  } catch (error) { result.errors.push(safeError(error, 'identity')); return { ...result, observedAt: new Date().toISOString() }; }
  try {
    const url = initial ? '/ajax/dashboard/works/illust/request_strategy?lang=zh'
      : `/ajax/dashboard/works/illust?offset=${offset}&limit=${limit}&lang=zh`;
    const json = parse(await read(url)), observedAt = new Date().toISOString();
    const works = json.body?.data?.works, thumbnails = json.body?.thumbnails?.illust;
    if (json.error) throw report('remote_error');
    if (!Array.isArray(works) || works.length > 1000 || !Array.isArray(thumbnails) || thumbnails.length > 2000) throw report('schema_changed');
    if (!initial && works.length > limit) throw report('schema_changed');
    const ids = works.map(work => String(work?.workId));
    if (ids.some(id => !/^\d+$/.test(id)) || new Set(ids).size !== ids.length) throw report('schema_changed');
    result.page = { offset: initial ? 0 : offset, limit: initial ? works.length : limit, count: works.length };
    result.attemptedArtworkIds = ids;
    if (initial) {
      const ranges = json.body.data.fetchRanges;
      if (!Array.isArray(ranges) || ranges.length > 50000) throw report('schema_changed');
      let end = works.length;
      for (const range of ranges) {
        if (!Array.isArray(range) || range.length !== 2 || !Number.isSafeInteger(range[0]) || range[0] !== end
          || !Number.isSafeInteger(range[1]) || range[1] < 1 || range[1] > 1000 || range[0] + range[1] > 50000) throw report('schema_changed');
        end += range[1];
      }
      result.fetchRanges = ranges.map(range => [...range]); result.total = end;
      result.nextRange = ranges.length ? { offset: ranges[0][0], limit: ranges[0][1] } : null;
    }
    const metric = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
    const thumbnail = (value, artworkId) => {
      if (typeof artworkId !== 'string' || !/^\d{1,20}$/.test(artworkId) || typeof value !== 'string' || value.length > 2048 || value.trim() !== value) return '';
      const match = /^https:\/\/i\.pximg\.net\/c\/(\d{1,3})x(\d{1,3})_(?:[1-9]\d?|100)(?:_a2)?\/(img-master|custom-thumb)\/img\/\d{4}(?:\/\d{2}){5}\/(\d{1,20})_p\d{1,3}_(square1200|master1200|custom1200)\.(?:jpe?g|png|webp|gif)$/i.exec(value);
      if (!match || Number(match[1]) < 1 || Number(match[1]) > 360 || Number(match[2]) < 1 || Number(match[2]) > 360
        || match[4] !== artworkId || (match[3].toLowerCase() === 'custom-thumb') !== (match[5].toLowerCase() === 'custom1200')) return '';
      return value.replace(/^https:\/\/i\.pximg\.net/i, 'https://i.pximg.net');
    };
    for (const work of works) {
      const artworkId = String(work.workId);
      try {
        const metadata = thumbnails.filter(item => String(item?.id) === artworkId);
        if (metadata.length !== 1) throw report('schema_changed');
        const item = metadata[0];
        if (String(item.userId) !== expectedId) throw report('owner_mismatch');
        if (work.isReserved === true || item.isReserved === true || work.isDraft === true || item.isDraft === true
          || ['reserved', 'draft', 'scheduled'].includes(work.status) || ['reserved', 'draft', 'scheduled'].includes(item.status)) throw report('not_published');
        // Owner-visible private / friends-only uploads still have real published
        // statistics. Visibility is metadata, not a draft indicator.
        const restrict = item.restrict ?? work.restrict;
        if (restrict !== undefined && ![0, 1, 2].includes(restrict)) throw report('schema_changed');
        if (typeof item.title !== 'string' || !Array.isArray(item.tags) || item.tags.some(tag => typeof tag !== 'string' || !tag || tag.length > 100)
          || typeof item.createDate !== 'string' || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(item.createDate)
          || !Number.isFinite(Date.parse(item.createDate)) || Date.parse(item.createDate) > Date.parse(observedAt)) throw report('schema_changed');
        const value = { artworkId, userId: expectedId, title: item.title.slice(0, 200), tags: [...new Set(item.tags)].slice(0, 10), thumbnailUrl: thumbnail(item.url, artworkId),
          createDate: new Date(item.createDate).toISOString(), createDateSource: 'pixiv-management-thumbnail', publicationTimeVerified: false,
          visibility: { restrict: restrict ?? null, visibilityScope: metric(item.visibilityScope),
            isUnlisted: typeof item.isUnlisted === 'boolean' ? item.isUnlisted : null, isMasked: typeof item.isMasked === 'boolean' ? item.isMasked : null },
          viewCount: metric(work.viewCount), bookmarkCount: metric(work.bookmarkCount), likeCount: metric(work.ratingCount), observedAt, source: 'pixiv-management-bulk' };
        result.artworks.push(value);
        if ([value.viewCount, value.bookmarkCount, value.likeCount].some(count => count === null)) result.errors.push({ phase: 'bulk', code: 'metrics_unavailable', artworkId });
      } catch (error) { result.failedArtworkIds.push(artworkId); result.errors.push(safeError(error, 'bulk', artworkId)); }
    }
    result.complete = result.errors.length === 0;
    return { ...result, observedAt };
  } catch (error) {
    result.errors.push(safeError(error, 'bulk'));
    return { ...result, observedAt: new Date().toISOString() };
  }
}
