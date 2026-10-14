import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_TAGS = 200;
const MAX_HISTORY = 5000;
const MAX_STORE_BYTES = 64 * 1024 * 1024;
const HISTORY_ERRORS = new Set(['http_error', 'timeout', 'network_error', 'invalid_json', 'schema_changed', 'remote_error', 'artwork_mismatch', 'owner_mismatch', 'not_published', 'browser_unavailable']);
export const normalizePoolTag = value => value.normalize('NFKC').toLowerCase().replace(/[\s_]/g, '');
const bad = (message, status = 400) => { const error = new Error(message); error.status = status; throw error; };
function tag(value) {
  if (typeof value !== 'string' || !value || value.length > 64 || /[\s\u0000-\u001f\u007f]/u.test(value.normalize('NFKC'))) bad('常用标签须为 1–64 个字符，不能含空格或控制字符。');
  return value.normalize('NFKC');
}
function unique(values, strict = false) {
  const found = new Map();
  for (const value of values || []) {
    try { const name = tag(value); if (!found.has(normalizePoolTag(name))) found.set(normalizePoolTag(name), name); }
    catch (error) { if (strict) throw error; }
  }
  return [...found.values()];
}
function inputTags(values) {
  if (!Array.isArray(values) || values.length > MAX_TAGS) bad(`每次最多处理 ${MAX_TAGS} 个常用标签。`);
  return unique(values, true);
}
function scopeKey(scope) {
  if (!['demo', 'live'].includes(scope?.mode) || typeof scope.accountId !== 'string' || !scope.accountId || scope.accountId.length > 100
    || typeof scope.pixivUserId !== 'string' || scope.pixivUserId.length > 30 || (scope.mode === 'live' && !/^\d{0,30}$/.test(scope.pixivUserId))) bad('常用标签的账号资料无效。');
  return JSON.stringify([scope.mode, scope.accountId, scope.pixivUserId]);
}
const empty = () => ({ manualTags: [], hiddenTags: [], remote: null });
// A history row is a posting recipe, so preserve its exact spelling and order.
// Pool normalization is only for finding/removing equivalent quick-pick tags.
function historyTags(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(value => typeof value === 'string' && value.length > 0 && value.length <= 64 && !/[\u0000-\u001f\u007f]/u.test(value)))].slice(0, 10);
}
function completedJobs(scope, jobs = []) {
  return jobs.filter(job => job.accountId === scope.accountId && scope.pixivUserId && String(job.pixivUserId || '') === scope.pixivUserId
    && job.tagsConfirmed === true && job.status === 'published')
    .sort((a, b) => String(b.publishedAt || b.updatedAt || b.createdAt || '').localeCompare(String(a.publishedAt || a.updatedAt || a.createdAt || '')));
}
function localHistory(scope, jobs) {
  return completedJobs(scope, jobs).flatMap(job => {
    const actualId = [job.artworkId, job.publishedId, /^artwork:(\d+)$/.exec(job.remoteId || '')?.[1]].find(value => /^\d+$/.test(String(value || '')));
    const artworkId = actualId ? String(actualId) : typeof job.id === 'string' && job.id ? `local:${job.id}` : null;
    if (!artworkId || !Array.isArray(job.tags)) return [];
    return [{ artworkId, title: typeof job.title === 'string' ? job.title.slice(0, 200) : '', tags: historyTags(job.tags), source: 'local-published', checkedAt: job.publishedAt || null }];
  });
}
function mergedHistory(first = [], remaining = [], sortArtworkIds = false) {
  const works = new Map();
  for (const work of [...first, ...remaining]) if (!works.has(work.artworkId)) works.set(work.artworkId, work);
  const rows = [...works.values()];
  if (sortArtworkIds) rows.sort((a, b) => BigInt(a.artworkId) > BigInt(b.artworkId) ? -1 : BigInt(a.artworkId) < BigInt(b.artworkId) ? 1 : 0);
  return rows.slice(0, MAX_HISTORY);
}
function localTags(scope, jobs = []) {
  // Draft suggestions are never silently treated as the user's preferences.
  // Old local jobs may survive a Pixiv-ID rebind. Without stored ownership,
  // their tags cannot establish preferences for the newly bound live account.
  return unique(completedJobs(scope, jobs).flatMap(job => job.tags || [])).slice(0, MAX_TAGS);
}
function view(scope, record, jobs, cached = true) {
  const hidden = new Set(record.hiddenTags.map(normalizePoolTag));
  const remoteTags = unique([...(record.remote?.frequentTags || []), ...(record.remote?.recentWorks || []).flatMap(work => work.tags)]);
  const local = localTags(scope, jobs), manual = record.manualTags.filter(name => !hidden.has(normalizePoolTag(name)));
  const tags = unique([...manual, ...remoteTags, ...local]).filter(name => !hidden.has(normalizePoolTag(name))).slice(0, MAX_TAGS);
  const source = record.remote ? (manual.length ? 'mixed' : 'pixiv') : manual.length ? (local.length ? 'mixed' : 'manual') : local.length ? 'local-history' : 'empty';
  return { ...scope, tags, manualTags: [...manual], hiddenTags: [...record.hiddenTags], checkedAt: record.remote?.checkedAt || null, source, cached, maxTags: MAX_TAGS,
    historyCount: record.remote?.recentWorks?.length || 0, maxHistory: MAX_HISTORY,
    historyScan: record.remote?.historyScan || null, historyWarning: record.remote?.historyWarning || null };
}
function scanRecord(scan, checkedAt, previous, incoming = []) {
  if (!scan || typeof scan !== 'object' || (scan.total !== null && (!Number.isInteger(scan.total) || scan.total < 0))) return null;
  const result = { source: 'pixiv-profile-all', checkedAt, total: scan.total === null ? null : Math.min(scan.total, 1000000) };
  for (const key of ['total', 'offset', 'nextOffset', 'attempted', 'succeeded', 'failed', 'remaining']) {
    if (Number.isInteger(scan[key]) && scan[key] >= 0) result[key] = Math.min(scan[key], 1000000);
  }
  // A page reaching the end is not proof that every earlier page succeeded.
  // Track one contiguous run from offset zero and retain failed IDs until an
  // actual successful detail read replaces them. A new offset-zero run starts
  // fresh; shuffled or middle-only pages still contribute usable artwork rows.
  const start = result.offset === 0;
  const continuous = !start && previous?.total === result.total && previous?.nextOffset === result.offset
    && (previous.coveredFromStart === true || previous.offset === 0);
  result.coveredFromStart = start || continuous;
  const currentFailures = [...new Set((Array.isArray(scan.failedArtworkIds) ? scan.failedArtworkIds : [])
    .filter(id => typeof id === 'string' && /^\d+$/.test(id)))];
  const previousFailures = start ? [] : (previous?.failedArtworkIds || []);
  const succeeded = new Set(incoming.map(work => work.artworkId));
  const unresolved = [...new Set([...previousFailures.filter(id => !succeeded.has(id)), ...currentFailures])];
  const unknownFailures = Math.max(0, (result.failed || 0) - currentFailures.length)
    + (start ? 0 : Math.max(0, (previous?.failed || 0) - previousFailures.length));
  result.failed = unresolved.length + unknownFailures;
  result.failedArtworkIds = unresolved.slice(0, MAX_HISTORY);
  result.rangeComplete = scan.complete === true && result.total !== null && (scan.failed || 0) === 0 && result.nextOffset >= result.total;
  result.storageTruncated = result.total > MAX_HISTORY;
  result.complete = result.rangeComplete && result.coveredFromStart && result.failed === 0 && !result.storageTruncated;
  result.truncated = scan.truncated === true;
  if (['index_unavailable', 'batch_unavailable', 'rate_limited', 'batch_time_budget', 'incomplete_batch', 'time_budget', 'work_limit'].includes(scan.stoppedReason)) result.stoppedReason = scan.stoppedReason;
  const lastError = scan.lastError || (!start && result.failed > 0 ? previous?.lastError : null);
  if (lastError && ['identity', 'index', 'detail'].includes(lastError.phase) && HISTORY_ERRORS.has(lastError.code)) {
    result.lastError = { phase: lastError.phase, code: lastError.code };
    if (Number.isInteger(lastError.httpStatus) && lastError.httpStatus >= 100 && lastError.httpStatus <= 599) result.lastError.httpStatus = lastError.httpStatus;
    if (typeof lastError.artworkId === 'string' && /^\d{1,30}$/.test(lastError.artworkId)) result.lastError.artworkId = lastError.artworkId;
    if (Number.isInteger(lastError.retryAfterSeconds) && lastError.retryAfterSeconds >= 0) result.lastError.retryAfterSeconds = Math.min(lastError.retryAfterSeconds, 86400);
  }
  if (scan.errorCounts && typeof scan.errorCounts === 'object' && !Array.isArray(scan.errorCounts)) {
    result.errorCounts = Object.fromEntries(Object.entries(scan.errorCounts).filter(([code, count]) =>
      (HISTORY_ERRORS.has(code) || /^http_error:[1-5]\d{2}$/.test(code)) && Number.isInteger(count) && count > 0)
      .map(([code, count]) => [code, Math.min(count, 1000000)]));
  }
  return result;
}
function remoteData(scope, result, previous) {
  if (String(result?.pixivUserId || '') !== scope.pixivUserId || !scope.pixivUserId) bad('Pixiv 账号与常用标签池不一致，已保留原有标签。', 409);
  if (!Array.isArray(result.frequentTags) || !Array.isArray(result.recentWorks) || !Number.isFinite(Date.parse(result.checkedAt))) bad('Pixiv 常用标签响应无效，已保留原有标签。', 502);
  const incoming = result.recentWorks.slice(0, MAX_HISTORY).filter(work => /^\d+$/.test(work?.artworkId || '') && Array.isArray(work.tags)).map(work => ({
    artworkId: String(work.artworkId), title: typeof work.title === 'string' ? work.title.slice(0, 200) : '', tags: historyTags(work.tags), source: 'pixiv-history', checkedAt: result.checkedAt,
  }));
  // Sync is a bounded recent window, never a complete deletion snapshot. Even
  // a successful or partially successful read must retain older verified works.
  const retained = (previous?.recentWorks || []).map(work => ({ ...work, tags: historyTags(work.tags), source: 'pixiv-history', checkedAt: work.checkedAt || previous.checkedAt }));
  // Older pages may arrive later. Refresh their content without promoting them
  // above newer works or evicting the newest page from the bounded archive.
  const recentWorks = mergedHistory(incoming, retained, true);
  const frequentTags = unique(result.frequentTags).slice(0, MAX_TAGS);
  const verified = new Map();
  for (const name of frequentTags) verified.set(normalizePoolTag(name), { tag: name, url: 'https://www.pixiv.net/illustration/create', checkedAt: result.checkedAt });
  for (const work of recentWorks) for (const name of work.tags) if (!verified.has(normalizePoolTag(name))) {
    verified.set(normalizePoolTag(name), { tag: name, url: `https://www.pixiv.net/artworks/${work.artworkId}`, checkedAt: work.checkedAt });
  }
  const historyScan = result.historyScan ? scanRecord(result.historyScan, result.checkedAt, previous?.historyScan, incoming) : previous?.historyScan || null;
  let historyWarning = typeof result.historyWarning === 'string' ? result.historyWarning.slice(0, 500) : null;
  if (!historyWarning && !result.historyScan) historyWarning = previous?.historyWarning || null;
  if (!historyWarning && historyScan && !historyScan.complete) {
    historyWarning = historyScan.storageTruncated ? `历史作品超过本地 ${MAX_HISTORY} 件保存上限，已保留最新作品；不能标记为完整收录。`
      : historyScan.failed > 0 ? `完整历史同步仍有 ${historyScan.failed} 件作品未读取成功；原有历史记录已保留。`
        : '完整历史同步尚未连续覆盖全部作品；本次已读取的历史记录已保留。';
  }
  return { frequentTags, recentWorks, checkedAt: result.checkedAt, verifiedTags: [...verified.values()], historyScan, historyWarning };
}

export async function createTagPools({ dataDir }) {
  const file = path.join(dataDir, 'tag-pools.json');
  let store = { version: 1, pools: {} };
  try {
    const bytes = await fs.readFile(file);
    if (bytes.length > MAX_STORE_BYTES) throw new Error('常用标签数据过大。');
    const loaded = JSON.parse(bytes);
    if (loaded?.version !== 1 || !loaded.pools || Array.isArray(loaded.pools) || typeof loaded.pools !== 'object') throw new Error('常用标签数据格式无效。');
    for (const [key, entry] of Object.entries(loaded.pools)) {
      const [mode, accountId, pixivUserId] = JSON.parse(key);
      if (scopeKey({ mode, accountId, pixivUserId }) !== key || !entry || !Array.isArray(entry.manualTags) || !Array.isArray(entry.hiddenTags)) throw new Error('常用标签数据格式无效。');
    }
    store = loaded;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let queue = Promise.resolve();
  const mutate = operation => {
    const pending = queue.then(async () => {
      const next = structuredClone(store), result = operation(next);
      const serialized = JSON.stringify(next, null, 2);
      if (Buffer.byteLength(serialized, 'utf8') > MAX_STORE_BYTES) bad('历史标签数据超过本机保存容量，原有记录已保留。', 413);
      const temp = `${file}.${randomUUID()}.tmp`;
      try { await fs.writeFile(temp, serialized, { mode: 0o600 }); await fs.rename(temp, file); }
      catch (error) { await fs.unlink(temp).catch(() => {}); throw error; }
      store = next;
      return result;
    });
    queue = pending.catch(() => {});
    return pending;
  };
  return {
    get(scope, { jobs = [], cached = true } = {}) { const record = store.pools[scopeKey(scope)] || empty(); return view(scope, record, jobs, cached); },
    edit(scope, { addTags = [], removeTags = [], jobs = [] } = {}) {
      const key = scopeKey(scope), add = inputTags(addTags), remove = inputTags(removeTags);
      if (!add.length && !remove.length) bad('请先选择要加入或移除的常用标签。');
      if (add.some(name => remove.some(other => normalizePoolTag(other) === normalizePoolTag(name)))) bad('同一标签不能同时加入和移除。');
      return mutate(next => {
        const record = next.pools[key] ||= empty(), added = new Set(add.map(normalizePoolTag)), removed = new Set(remove.map(normalizePoolTag));
        const prior = view(scope, record, jobs).tags.filter(name => !removed.has(normalizePoolTag(name)));
        if (unique([...prior, ...add]).length > MAX_TAGS) bad(`常用标签池最多 ${MAX_TAGS} 个，请先移除一些标签。`);
        record.manualTags = unique([...record.manualTags.filter(name => !removed.has(normalizePoolTag(name))), ...add]);
        record.hiddenTags = unique([...record.hiddenTags.filter(name => !added.has(normalizePoolTag(name))), ...remove]);
        return view(scope, record, jobs);
      });
    },
    sync(scope, result, { jobs = [] } = {}) {
      const key = scopeKey(scope);
      return mutate(next => { const record = next.pools[key] ||= empty(); record.remote = remoteData(scope, result, record.remote); return view(scope, record, jobs, false); });
    },
    evidence(scope, queries = [], { jobs = [] } = {}) {
      const record = store.pools[scopeKey(scope)] || empty(), pool = view(scope, record, jobs), remote = record.remote;
      const publishedIds = new Set((remote?.recentWorks || []).map(work => work.artworkId));
      const recentWorks = mergedHistory(localHistory(scope, jobs).filter(work => !publishedIds.has(work.artworkId)), remote?.recentWorks || []);
      const matches = [];
      for (const query of queries) for (const proof of remote?.verifiedTags || []) if (normalizePoolTag(query.word) === normalizePoolTag(proof.tag)) {
        matches.push({ word: query.word, ...proof, source: 'pixiv-cache', cached: true, verified: true });
      }
      return { source: 'pixiv-cache', cached: true, pixivUserId: scope.pixivUserId, checkedAt: remote?.checkedAt || null,
        preferredTags: pool.tags, frequentTags: [...(remote?.frequentTags || [])], recentWorks: structuredClone(recentWorks), matches };
    },
  };
}
