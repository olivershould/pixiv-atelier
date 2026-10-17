import { randomUUID } from 'node:crypto';
import { ANALYTICS_INTERVAL_MS } from './analytics.mjs';

export const analyticsAccountKey = account => `live:${account.id}:${account.pixivUserId}`;
const iso = value => new Date(value).toISOString();
const clone = value => structuredClone(value);
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const hasAccountSample = value => value && [value.views ?? value.viewCount, value.followers ?? value.followerCount].some(item => count(item) !== null);

// Collectors only read Pixiv. They never invoke queue, reservation, or upload APIs.
// Small browser batches leave the shared connection available for normal use.
export function createAnalyticsCollector({ store, getContext, fetchAnalytics, getCharacters = async () => [],
  getSeedWorks = async () => [], now = () => new Date(), batchDelayMs = 5000 } = {}) {
  const clock = () => iso(now());
  const meta = store.getMeta('collector:v1', { accounts: {}, run: null });
  meta.accounts ||= {};
  let pending = null, closed = false, pauseTimer, resumePause, activeContextVersion;
  let run = meta.run ? { ...meta.run, running: false,
    ...(meta.run.running ? { message: '上次采集中断，将从已保存的进度继续。' } : {}) } : { running: false, message: '尚未采集作品数据。', errors: [] };
  const save = () => { meta.run = clone(run); store.setMeta('collector:v1', meta); };
  const eligible = () => {
    const context = getContext();
    return context.mode === 'live' ? context.accounts.filter(a => /^\d+$/.test(a.pixivUserId || '') && a.browser?.targetId) : [];
  };
  const valid = account => !closed && getContext().contextVersion === activeContextVersion
    && eligible().some(a => a.id === account.id && a.pixivUserId === account.pixivUserId && a.browser.targetId === account.browser.targetId);
  function entry(account) {
    const key = analyticsAccountKey(account);
    return meta.accounts[key] ||= { nextRegularAt: clock(), retryAt: null, failures: 0, cycle: null, milestoneRetries: {} };
  }
  function error(account, message) {
    if (!run.errors.some(item => item.accountId === account.id && item.message === message)) run.errors.push({ accountId: account.id, message: String(message).slice(0, 400) });
    run.errors = run.errors.slice(-50);
  }
  function delay() {
    if (closed || batchDelayMs <= 0) return Promise.resolve();
    return new Promise(resolve => { resumePause = resolve; pauseTimer = setTimeout(() => { resumePause = null; resolve(); }, batchDelayMs); });
  }
  function postpone(account, milliseconds, message, code = 'retry') {
    const state = entry(account);
    state.retryAt = iso(Date.parse(clock()) + Math.max(60000, milliseconds));
    state.retryCode = code;
    if (message) error(account, message);
  }
  function ingest(account, result, runId, kind, characters) {
    if (!valid(account)) throw new Error('采集期间账号或工作空间已变更，本批数据未保存。');
    if (String(result?.pixivUserId || '') !== account.pixivUserId) throw new Error('返回数据与绑定的 Pixiv 账号不一致，本批数据未保存。');
    if (result.index?.pixivUserId != null && String(result.index.pixivUserId) !== account.pixivUserId) throw new Error('作品索引与绑定的 Pixiv 账号不一致，本批数据未保存。');
    const works = (result.artworks || result.works || []).filter(work => /^\d+$/.test(String(work.artworkId))
      && String(work.userId || result.pixivUserId) === account.pixivUserId).map(work => ({
        ...work, publishedAt: work.publishedAt || work.createDate,
        metrics: work.metrics || { views: count(work.viewCount), bookmarks: count(work.bookmarkCount), likes: count(work.likeCount) },
      }));
    const raw = result.account;
    const observedAt = result.observedAt || clock();
    const saved = store.recordBatch(analyticsAccountKey(account), { works, observedAt, runId, kind, characters,
      account: raw ? { views: count(raw.views ?? raw.viewCount), followers: count(raw.followers ?? raw.followerCount),
        observedAt: raw.observedAt || observedAt, sources: raw.sources || raw.source || {} } : undefined });
    run.recordedWorks += saved.recorded;
    if (saved.accountRecorded) run.recordedAccounts++;
    if (result.rateLimited) postpone(account, (result.retryAfterSeconds || 60) * 1000, 'Pixiv 暂时限制读取频率，已保存进度并延后重试。', 'rate_limited');
    for (const item of result.errors || []) error(account, item.message || `读取统计失败：${item.code || 'unknown'}${item.artworkId ? `（作品 ${item.artworkId}）` : ''}`);
    return works;
  }
  async function fetchBatch(account, input, runId, kind, characters) {
    if (!valid(account)) return null;
    run.accountId = account.id;
    const result = await fetchAnalytics(account, input);
    const works = ingest(account, result, runId, kind, characters);
    entry(account).failures = 0;
    return { ...result, observedArtworkIds: works.filter(work => ['views', 'bookmarks', 'likes'].some(key => count(work.metrics[key]) !== null))
      .map(work => String(work.artworkId)) };
  }
  async function milestones(accounts, characters) {
    let didWork = false;
    for (const account of accounts) {
      if (!valid(account)) continue;
      const state = entry(account), stamp = clock();
      if (state.retryAt && state.retryAt > stamp) continue;
      const due = store.dueMilestones({ accountId: analyticsAccountKey(account), now: stamp, limit: 200 })
        .filter(node => !state.milestoneRetries[`${node.artworkId}:${node.point}`] || state.milestoneRetries[`${node.artworkId}:${node.point}`] <= stamp).slice(0, 10);
      if (!due.length) continue;
      const ids = [...new Set(due.map(node => node.artworkId))];
      try {
        await fetchBatch(account, { artworkIds: ids }, `milestone:${randomUUID()}`, 'milestone', characters);
        // Retry only missing readings; recorded milestones disappear from due().
        for (const node of due) state.milestoneRetries[`${node.artworkId}:${node.point}`] = iso(Date.parse(clock()) + 60000);
        run.message = `正在记录发布节点数据，已保存 ${run.recordedWorks} 件作品观测。`;
      } catch (cause) { postpone(account, 60000, cause.message, cause.code || 'retry'); }
      save(); didWork = true;
      await delay();
    }
    return didWork;
  }
  async function periodicBatch(account, characters) {
    const state = entry(account), stamp = clock();
    if (!valid(account) || state.retryAt && state.retryAt > stamp) return false;
    if (!state.cycle && state.nextRegularAt > stamp) return false;
    state.cycle ||= { id: `periodic:${randomUUID()}`, startedAt: stamp, pendingIds: null, failedIds: [], retried: false, scanned: 0, accountPending: false };
    const cycle = state.cycle;
    try {
      if (cycle.pendingIds === null) {
        const seeds = await getSeedWorks(account);
        if (!valid(account)) return false;
        store.upsertWorks(analyticsAccountKey(account), seeds, { observedAt: stamp, characters });
        const response = await fetchBatch(account, { includeIndex: true, includeAccount: true, bulk: true }, cycle.id, 'periodic', characters);
        if (!response) return false;
        if (!response.index?.complete || !Array.isArray(response.index.artworkIds)) {
          if (!response.rateLimited) postpone(account, 60000, '作品索引未读取完整，已保留原有数据，稍后重试。');
          save(); return true;
        }
        const recorded = new Set(response.observedArtworkIds);
        cycle.pendingIds = [...new Set(response.index.artworkIds.map(String))].filter(id => /^\d+$/.test(id) && !recorded.has(id)).sort((a, b) => Number(b) - Number(a));
        cycle.total = new Set(response.index.artworkIds.map(String).filter(id => /^\d+$/.test(id))).size;
        cycle.accountPending = Boolean(response.rateLimited && !hasAccountSample(response.account));
        cycle.bulkRanges = Array.isArray(response.fetchRanges) ? response.fetchRanges.filter(range => Array.isArray(range)
          && range.length === 2 && Number.isSafeInteger(range[0]) && range[0] >= 0 && Number.isSafeInteger(range[1]) && range[1] > 0 && range[1] <= 1000) : [];
        cycle.calibrationAttempted ||= [];
      } else if (cycle.accountPending) {
        const response = await fetchBatch(account, { includeAccount: true }, cycle.id, 'periodic', characters);
        if (!response) return false;
        cycle.accountPending = Boolean(response.rateLimited && !hasAccountSample(response.account));
      } else if (cycle.bulkRanges?.length) {
        const [offset, limit] = cycle.bulkRanges[0];
        const response = await fetchBatch(account, { bulk: true, offset, limit }, cycle.id, 'periodic', characters);
        if (!response) return false;
        const successes = new Set(response.observedArtworkIds);
        cycle.pendingIds = cycle.pendingIds.filter(id => !successes.has(id));
        cycle.scanned += successes.size;
        // Missing, shifted, or malformed page rows remain in pendingIds and
        // are recovered by authenticated individual reads after bulk pages.
        if (!response.rateLimited) cycle.bulkRanges.shift();
      } else if (cycle.pendingIds.length) {
        const batch = cycle.pendingIds.slice(0, 10);
        const response = await fetchBatch(account, { artworkIds: batch }, cycle.id, 'periodic', characters);
        if (!response) return false;
        const successes = new Set(response.observedArtworkIds.filter(id => batch.includes(id)));
        const attempted = new Set((Array.isArray(response.attemptedArtworkIds) ? response.attemptedArtworkIds : batch).map(String).filter(id => batch.includes(id)));
        const previousCount = cycle.pendingIds.length;
        cycle.pendingIds = cycle.pendingIds.filter(id => !successes.has(id) && (!attempted.has(id) || response.rateLimited));
        if (!response.rateLimited) for (const id of batch) if (attempted.has(id) && !successes.has(id)) cycle.failedIds.push(id);
        cycle.scanned += successes.size;
        if (previousCount === cycle.pendingIds.length && !response.rateLimited) postpone(account, 60000, '本批未获得有效作品数据，已保留进度并稍后重试。');
      }
      let calibrationPending = false;
      if (cycle.pendingIds !== null && !cycle.accountPending && !(state.retryAt && state.retryAt > clock()) && store.unverifiedRecentWorks) {
        cycle.calibrationAttempted ||= [];
        const candidates = store.unverifiedRecentWorks({ accountId: analyticsAccountKey(account),
          since: iso(Date.parse(clock()) - 7 * 86400000), limit: 10000 }).filter(work => work.publicationTimeVerified === false && !cycle.calibrationAttempted.includes(work.artworkId));
        const ids = candidates.slice(0, 10).map(work => work.artworkId);
        if (ids.length) {
          const response = await fetchBatch(account, { artworkIds: ids }, `${cycle.id}:publication-check`, 'calibration', characters);
          if (response) {
            const attempted = response.rateLimited ? response.observedArtworkIds : response.attemptedArtworkIds || ids;
            cycle.calibrationAttempted.push(...attempted);
            if (!response.rateLimited && !attempted.length) cycle.calibrationAttempted.push(...ids);
            if (ids.some(id => !response.observedArtworkIds.includes(id))) error(account, '部分新作品的实际发布时间仍待核对，暂不纳入增长榜。');
          }
          calibrationPending = candidates.length > ids.length || Boolean(response?.rateLimited);
        }
      }
      if (cycle.pendingIds?.length === 0 && !cycle.accountPending && !cycle.bulkRanges?.length && !calibrationPending) {
        if (cycle.failedIds.length && !cycle.retried) {
          cycle.pendingIds = [...new Set(cycle.failedIds)]; cycle.failedIds = []; cycle.retried = true;
          postpone(account, 60000);
        } else {
          if (cycle.failedIds.length) error(account, `${cycle.failedIds.length} 件作品暂未取得数据，原有记录已保留。`);
          else store.completePeriodicRun?.(analyticsAccountKey(account), {
            runId: cycle.id, completedAt: clock(), expectedWorkCount: cycle.total,
          });
          const started = Date.parse(cycle.startedAt), elapsed = Math.max(0, Date.parse(clock()) - started);
          state.nextRegularAt = iso(started + (Math.floor(elapsed / ANALYTICS_INTERVAL_MS) + 1) * ANALYTICS_INTERVAL_MS);
          state.cycle = null;
          if (!state.retryAt || state.retryAt <= clock()) { state.retryAt = null; state.retryCode = null; }
        }
      }
      run.message = `正在更新 ${account.name || '账号'} 的统计，已保存 ${run.recordedWorks} 件作品观测。`;
      save(); return true;
    } catch (cause) {
      state.failures = (state.failures || 0) + 1;
      postpone(account, Math.min(ANALYTICS_INTERVAL_MS, 60000 * 2 ** Math.min(state.failures - 1, 8)), cause.message, cause.code || 'retry');
      save(); return false;
    }
  }
  async function execute(selectedKeys) {
    const milestoneAccounts = () => getContext().contextVersion === activeContextVersion ? eligible().map(clone) : [];
    const selectedAccounts = () => milestoneAccounts().filter(account => selectedKeys.has(analyticsAccountKey(account)));
    try {
      const characters = await getCharacters();
      do {
        const accounts = selectedAccounts();
        if (!accounts.length || closed) break;
        // Manual account scope limits the full archive scan. Precise-age reads
        // remain global so another account's deadline cannot be starved by it.
        let work = await milestones(milestoneAccounts(), characters);
        for (const account of accounts) {
          if (closed) break;
          // Check the precise-age queue between every bounded periodic batch.
          work = await milestones(milestoneAccounts(), characters) || work;
          if (await periodicBatch(account, characters)) { work = true; await delay(); }
        }
        if (!work) break;
      } while (!closed);
    } catch (cause) { run.errors.push({ message: String(cause.message).slice(0, 400) }); }
    finally {
      run.running = false; run.completedAt = clock(); delete run.accountId;
      run.message = run.errors.length ? `本轮已记录 ${run.recordedWorks} 件作品观测；部分数据待重试。` : `本轮已记录 ${run.recordedWorks} 件作品观测、${run.recordedAccounts} 次账号数据。`;
      save();
    }
  }
  function start({ accountId = 'all', force = false } = {}) {
    if (closed || pending) return status();
    const accounts = eligible().filter(a => accountId === 'all' || a.id === accountId);
    if (!accounts.length) return status();
    if (force) for (const account of accounts) {
      const state = entry(account);
      // Legacy metadata did not keep error codes. Recognize only the exact
      // Chrome-consent error; unknown errors and Pixiv cooldowns stay intact.
      const previousErrors = (run.errors || []).filter(item => item.accountId === account.id);
      const legacyApproval = !state.retryCode && previousErrors.length === 1
        && previousErrors[0].message === 'Chrome 尚未允许后台连接，请在远程调试提示中点击允许后重试。';
      if (state.retryCode === 'approval_required' || legacyApproval) {
        state.retryAt = null; state.retryCode = null; state.failures = 0;
      }
      if (!state.cycle) state.nextRegularAt = clock();
    }
    const ready = accounts.some(account => {
      const state = entry(account), stamp = clock();
      return !(state.retryAt && state.retryAt > stamp) && (Boolean(state.cycle) || state.nextRegularAt <= stamp || store.dueMilestones({ accountId: analyticsAccountKey(account), now: stamp }).some(node => !state.milestoneRetries[`${node.artworkId}:${node.point}`] || state.milestoneRetries[`${node.artworkId}:${node.point}`] <= stamp));
    });
    if (!ready) return status();
    run = { id: randomUUID(), running: true, startedAt: clock(), completedAt: null, source: force ? 'manual' : 'automatic', recordedWorks: 0, recordedAccounts: 0, errors: [], message: '正在读取 Pixiv 统计数据…' };
    activeContextVersion = getContext().contextVersion;
    save();
    pending = execute(new Set(accounts.map(analyticsAccountKey))).finally(() => { pending = null; });
    return status();
  }
  function status() {
    const accounts = eligible();
    const next = accounts.map(account => { const state = entry(account); return state.retryAt && state.retryAt > clock() ? state.retryAt : state.cycle ? clock() : state.nextRegularAt; }).sort()[0] || null;
    return { ...clone(run), nextRegularAt: next, accounts: accounts.map(account => {
      const state = entry(account); return { accountId: account.id, nextRegularAt: state.nextRegularAt, retryAt: state.retryAt,
        remainingWorks: state.cycle?.pendingIds?.length ?? null, totalWorks: state.cycle?.total ?? null };
    }) };
  }
  return { start, status, idle: () => pending || Promise.resolve(),
    async close() { closed = true; clearTimeout(pauseTimer); resumePause?.(); await pending; } };
}
