import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { BrowserError, readIdentity, readRemote, readForm, chooseSchedule, readPublished, clickSubmit, readTags, readPublishedHistory } from './browser-driver.mjs';
import { createBackgroundBrowser } from './background-browser.mjs';
import { chromeEndpoint } from './chrome-endpoint.mjs';
import { validateJob } from './queue.mjs';
import { readAccountAvatar } from './account-avatar.mjs';
import { readArtworkAnalytics, readAnalyticsOverview, readAnalyticsWorksPage } from './browser-analytics.mjs';

const clone = value => structuredClone(value);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const pixiv = tab => { try { return new URL(tab.url).origin === 'https://www.pixiv.net' && /^[A-Fa-f0-9]{16,64}$/.test(tab.targetId); } catch { return false; } };
const reject = (message, code) => { throw new BrowserError(message, code); };

export const titleMatches = (remote, local) => local ? remote === local : ['', '無題', '无题', 'Untitled'].includes(remote);

export function remoteDate(value) {
  if (typeof value !== 'string') return null;
  // Pixiv's dashboard timestamps without an offset are Japan local time.
  const text = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(' ', 'T')}+09:00` : value;
  if (!/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(text) || !Number.isFinite(Date.parse(text))) return null;
  return new Date(text).toISOString();
}

export function normalizeRemote(data) {
  if (!data?.identity?.pixivUserId || !Array.isArray(data.responses) || data.responses.length !== 2) reject('预约快照不完整。');
  if (new Set(data.responses.map(response => response?.kind)).size !== 2 || !data.responses.every(response => ['illust', 'novel'].includes(response?.kind))) reject('预约快照不完整。');
  const reservations = [], ids = new Set();
  for (const response of data.responses) {
    if (!Array.isArray(response.reserved)) reject('预约快照格式无效。');
    for (const item of response.reserved) {
      if (!/^\d+$/.test(String(item.reserveId))) reject('预约记录缺少可验证的 ID。');
      const remoteId = `${response.kind}:${item.reserveId}`;
      if (ids.has(remoteId)) reject('远端预约列表含重复记录。');
      ids.add(remoteId);
      reservations.push({ remoteId, reserveId: String(item.reserveId), kind: response.kind, status: 'reserved',
        scheduledAt: remoteDate(item.releaseDate), title: typeof item.title === 'string' ? item.title : '', pageCount: item.pageCount });
    }
  }
  return { ok: true, connected: true, premium: data.identity.premium === true, complete: true,
    pixivUserId: data.identity.pixivUserId, name: data.identity.name, total: reservations.length, reservations };
}

export function scheduleLabels(value) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value)).map(p => [p.type, p.value]));
  return { date: `${parts.year}年${parts.month}月${parts.day}日`, time: `${parts.hour}:${parts.minute} JST` };
}

export function unsupportedFields(job) {
  const c = job.content || {}, issues = [];
  if (c.seriesId) issues.push('系列');
  if (c.imageResponse || c.allowImageResponse) issues.push('关联作品');
  if (c.tools?.length) issues.push('使用工具');
  if ([...(job.tags || []), c.contestTag || ''].some(tag => /\s/.test(tag))) issues.push('含空格的标签');
  if (c.adultAttributes?.length) issues.push('成人内容属性');
  if (c.poll?.question || c.poll?.answers?.length) issues.push('问卷');
  if (c.thumbnail && (c.thumbnail.page !== 1 || c.thumbnail.x !== .5 || c.thumbnail.y !== .5)) issues.push('自定义缩略图');
  return issues;
}

// A fresh response distinguishes a logged-out dedicated profile from a profile
// logged in as somebody else. No credentials or serialized state leave Chrome.
async function readDedicatedIdentity() {
  if (location.origin !== 'https://www.pixiv.net') return { loggedIn: false, pixivUserId: '' };
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch('/dashboard/works', { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal });
    if (!response.ok) throw new Error('无法核对专用浏览器的 Pixiv 登录状态。');
    const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
    const props = JSON.parse(doc.getElementById('__NEXT_DATA__')?.textContent || '{}').props?.pageProps;
    if (!props) throw new Error('Pixiv 登录页面格式发生变化。');
    const state = JSON.parse(props.serverSerializedPreloadedState || '{}');
    return { loggedIn: props.isLoggedIn === true, pixivUserId: String(state.userData?.self?.id || props.gaUserData?.userId || '') };
  } finally { clearTimeout(timer); }
}

export async function createBrowserConnector({ dataDir, driver, dedicatedChrome, dedicatedDriverFactory = createBackgroundBrowser,
  now = () => new Date(), historyBatchDelayMs = 5000 } = {}) {
  let config = {};
  try { config = JSON.parse(await fs.readFile(path.join(dataDir, 'browser-config.json'), 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const sharedBrowser = driver || createBackgroundBrowser({ endpoint: () => chromeEndpoint({ userDataDir: config.userDataDir }) });
  const dedicatedBrowsers = new Map();
  const isDedicated = account => account?.browser?.mode === 'dedicated';
  const dedicatedKey = account => `${account.id}:${account.pixivUserId}`;
  function dedicatedSession(value) {
    let url;
    try { url = new URL(value?.endpoint); } catch {}
    if (!url || !['ws:', 'wss:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.username || url.password || !['headless', 'interactive'].includes(value.mode)) reject('专用 Chrome 返回的连接信息无效。', 'dedicated_unavailable');
    return value;
  }
  async function dedicatedEntry(account) {
    if (!account?.id || !/^\d+$/.test(account.pixivUserId || '')) reject('请先设置此账号的 Pixiv ID。', 'unbound');
    if (!dedicatedChrome?.ensure) reject('尚未配置专用 Chrome 管理器。', 'dedicated_unavailable');
    const key = dedicatedKey(account);
    let entry = dedicatedBrowsers.get(key);
    if (!entry) {
      entry = { account: clone(account), driver: null, targetId: null, runtimeMode: null, targetChain: Promise.resolve() };
      dedicatedBrowsers.set(key, entry);
      entry.ready = (async () => {
        let initial = dedicatedSession(await dedicatedChrome.ensure(entry.account));
        entry.runtimeMode = initial.mode;
        entry.driver = dedicatedDriverFactory({ account: clone(entry.account), dedicated: true, endpoint: async () => {
          const connected = initial || dedicatedSession(await dedicatedChrome.ensure(entry.account));
          initial = null; entry.runtimeMode = connected.mode; entry.targetId = null;
          return connected.endpoint;
        } });
        return entry;
      })().catch(error => { if (dedicatedBrowsers.get(key) === entry) dedicatedBrowsers.delete(key); throw error; });
    }
    return entry.ready;
  }
  async function releaseDedicated(account) {
    const key = dedicatedKey(account), entry = dedicatedBrowsers.get(key);
    if (!entry) return;
    dedicatedBrowsers.delete(key);
    await entry.ready.then(value => value.driver.close?.()).catch(() => {});
  }
  const browserScope = new AsyncLocalStorage();
  // A reservation owns its cursor for its entire async lifetime. The transport
  // and Chrome consent are shared; another job cannot redirect its commands.
  const browser = Object.fromEntries(['tabs', 'select', 'evaluate', 'openTab', 'command'].map(method =>
    [method, (...args) => (browserScope.getStore() || sharedBrowser)[method](...args)]));
  async function inAccount(account, task, { reservation = false } = {}) {
    const selectedDriver = isDedicated(account) ? (await dedicatedEntry(account)).driver : sharedBrowser;
    const scoped = typeof selectedDriver.fork === 'function' ? selectedDriver.fork() : selectedDriver;
    const run = () => browserScope.run(scoped, task);
    try { return await (reservation && scoped === selectedDriver ? atomic(run) : run()); }
    finally { if (scoped !== selectedDriver) scoped.close?.(); }
  }
  const ledgerPath = path.join(dataDir, 'browser-ledger.json');
  let ledger = {};
  try { ledger = JSON.parse(await fs.readFile(ledgerPath, 'utf8')); if (!ledger || Array.isArray(ledger) || typeof ledger !== 'object') throw new Error('投稿记录损坏；停止连接以防重复投稿。'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  let chain = Promise.resolve(), ledgerWrites = Promise.resolve(), candidates = new Map();
  const submissions = new Map();
  // This internal constructor option is for isolated tests only. No HTTP
  // request or account setting can bypass the shared history pacing.
  const historyInterval = Number.isFinite(historyBatchDelayMs) ? Math.max(0, Math.min(60000, historyBatchDelayMs)) : 5000;
  let historyFinishedAt = 0, historyResumeAfter = 0;
  let analyticsResumeAfter = 0;
  async function historySlot(deadline) {
    const wait = Math.max(0, historyFinishedAt + historyInterval - Date.now(), historyResumeAfter - Date.now());
    if (Date.now() + wait >= deadline) return false;
    if (wait) await delay(wait);
    return true;
  }
  function safeHistoryError(value, phase = 'index') {
    const codes = ['http_error', 'timeout', 'network_error', 'invalid_json', 'schema_changed', 'remote_error', 'artwork_mismatch', 'owner_mismatch', 'not_published', 'browser_unavailable'];
    return { phase: ['identity', 'index', 'detail'].includes(value?.phase) ? value.phase : phase,
      code: codes.includes(value?.code) ? value.code : value?.code === 'timeout' ? 'timeout' : 'browser_unavailable',
      ...(Number.isInteger(value?.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599 ? { httpStatus: value.httpStatus } : {}),
      ...(typeof value?.artworkId === 'string' && /^\d+$/.test(value.artworkId) ? { artworkId: value.artworkId } : {}),
      ...(Number.isInteger(value?.retryAfterSeconds) && value.retryAfterSeconds >= 0 ? { retryAfterSeconds: Math.min(86400, value.retryAfterSeconds) } : {}) };
  }
  function historyErrorMessage(error) {
    const phase = { identity: '核对登录状态', index: '读取历史列表', detail: '读取作品标签' }[error.phase];
    const reason = error.code === 'http_error' ? `Pixiv 返回 HTTP ${error.httpStatus || '错误'}`
      : { timeout: '请求超时', network_error: '网络请求失败', invalid_json: '返回内容不是有效 JSON', schema_changed: '返回数据格式发生变化',
        remote_error: 'Pixiv 返回操作失败', artwork_mismatch: '作品 ID 与请求不一致', owner_mismatch: '作品作者与绑定账号不一致',
        not_published: '作品尚未发布', browser_unavailable: '浏览器读取失败' }[error.code];
    return `${phase}时${reason}${error.retryAfterSeconds ? `，服务端要求至少等待 ${error.retryAfterSeconds} 秒` : ''}。`;
  }
  const atomic = task => { const result = chain.then(task); chain = result.catch(() => {}); return result; };
  function save() {
    const contents = JSON.stringify(ledger, null, 2);
    const saved = ledgerWrites.then(async () => {
      const temp = `${ledgerPath}.${randomUUID()}.tmp`;
      try { await fs.writeFile(temp, contents, { mode: 0o600 }); await fs.rename(temp, ledgerPath); }
      catch (error) { await fs.unlink(temp).catch(() => {}); throw error; }
    });
    ledgerWrites = saved.catch(() => {});
    return saved;
  }
  function submitForAccount(account, task) {
    // Two local bindings for one Pixiv identity must share the commit lock.
    const identity = String(account.pixivUserId), previous = submissions.get(identity) || Promise.resolve();
    const result = previous.then(task), settled = result.catch(() => {});
    submissions.set(identity, settled);
    void settled.then(() => { if (submissions.get(identity) === settled) submissions.delete(identity); });
    return result;
  }
  async function closeConfirmedForm(key, account) {
    const item = ledger[key];
    if (item.phase !== 'confirmed' || !item.ownedTargetId || item.ownedTargetId === account.browser?.targetId) return;
    try {
      if ((await browser.tabs()).some(tab => tab.targetId === item.ownedTargetId)) {
        await browser.command(['tab', 'close', item.ownedTargetId]);
      }
      item.formClosedAt = new Date(now()).toISOString();
    } catch (error) { item.formCloseError = String(error.message || '投稿页未能自动关闭。').slice(0, 500); }
    // Failure to close a page cannot undo a confirmed reservation or make it
    // eligible for resubmission. The confirmed record was saved beforehand.
    await save().catch(() => {});
  }
  async function select(targetId) {
    const tab = (await browser.tabs()).find(t => t.targetId === targetId && pixiv(t));
    if (!tab) reject('绑定的 Pixiv 标签页已关闭。请在账号管理中重新连接 Chrome。', 'tab_gone');
    await browser.select(targetId); return tab;
  }
  async function selectAccount(account) {
    if (!isDedicated(account)) return select(account.browser?.targetId);
    const entry = await dedicatedEntry(account);
    const selected = entry.targetChain.then(async () => {
      const tabs = await browser.tabs();
      const forms = new Set(Object.values(ledger).filter(item => item.pixivUserId === account.pixivUserId).map(item => item.ownedTargetId).filter(Boolean));
      const candidates = tabs.filter(tab => pixiv(tab) && !forms.has(tab.targetId)
        && !/^\/(?:illustration|manga)\/create\/?$/.test(new URL(tab.url).pathname));
      let tab = candidates.find(item => item.targetId === entry.targetId)
        || candidates.find(item => item.targetId === account.browser?.targetId) || candidates[0];
      if (!tab) tab = await browser.openTab('https://www.pixiv.net/dashboard/works');
      if (!pixiv(tab)) reject('请在此账号的专用 Chrome 窗口中登录 Pixiv，再验证连接。', 'login_required');
      // Target IDs change after a managed Chrome restart. Only this account's
      // dedicated endpoint is searched; never fall back to the user's Chrome.
      entry.targetId = tab.targetId;
      await browser.select(tab.targetId);
      return tab;
    });
    entry.targetChain = selected.catch(() => {});
    return selected;
  }
  async function verify(account, targetId = account.browser?.targetId, options = {}) {
    if ((!targetId && !isDedicated(account)) || !/^\d+$/.test(account.pixivUserId)) reject('此账号尚未绑定 Chrome 标签页。', 'unbound');
    if (isDedicated(account) && (!targetId || targetId === account.browser?.targetId)) await selectAccount(account);
    else await select(targetId);
    const data = await browser.evaluate(readRemote, { expectedId: account.pixivUserId, ...options });
    if (data?.identity?.pixivUserId !== account.pixivUserId) reject('当前 Pixiv 账号与绑定 ID 不符，已停止操作。', 'identity_mismatch');
    return data;
  }
  async function verifyDedicatedAccount(account) {
    await selectAccount(account);
    await browser.command(['wait', '--fn', "document.readyState === 'complete'"]);
    const identity = await browser.evaluate(readDedicatedIdentity);
    if (!identity?.loggedIn) reject('此账号的专用 Chrome 尚未登录 Pixiv，请完成登录后再验证。', 'login_required');
    if (identity.pixivUserId !== account.pixivUserId) reject('专用 Chrome 登录的 Pixiv ID 与原账号不符；请切换到原账号后再验证。', 'identity_mismatch');
    const result = await snapshot(account, { jobs: [] }), entry = await dedicatedEntry(account);
    return { account: { ...account, browser: { ...account.browser, mode: 'dedicated', runtimeMode: entry.runtimeMode,
      targetId: entry.targetId, postingEnabled: false, loginPending: false, verifiedAt: new Date(now()).toISOString() } }, snapshot: result };
  }
  function publicationExpected(job, pageCount = job?.files?.length) {
    if (typeof job?.title !== 'string' || !Number.isInteger(pageCount) || pageCount < 1 || pageCount > 200
      || !['illust', 'manga'].includes(job.content?.type) || !remoteDate(job.scheduledAt)) return null;
    const value = { title: job.title, pageCount, illustType: job.content.type === 'manga' ? 1 : 0, scheduledAt: remoteDate(job.scheduledAt) };
    const tags = Array.isArray(job.tags) ? [...new Set([...job.tags, ...(job.content.contestTag ? [job.content.contestTag] : [])])] : null;
    const xRestrict = { all: 0, r18: 1, r18g: 2 }[job.content.rating];
    if (job.tagsConfirmed === true && validPublicationEvidence({ tags, xRestrict })) Object.assign(value, { tags: tags.sort(), xRestrict });
    return value;
  }
  function validPublicationEvidence(value) {
    return Array.isArray(value?.tags) && value.tags.length <= 10
      && value.tags.every(tag => typeof tag === 'string' && tag.length > 0 && tag.length <= 100 && !/[\u0000-\u001f\u007f]/.test(tag))
      && new Set(value.tags).size === value.tags.length && Number.isInteger(value.xRestrict) && [0, 1, 2].includes(value.xRestrict);
  }
  const samePublicationEvidence = (left, right) => validPublicationEvidence(left) && validPublicationEvidence(right)
    && left.xRestrict === right.xRestrict && JSON.stringify([...left.tags].sort()) === JSON.stringify([...right.tags].sort());
  function validExpected(item) {
    const value = item.publicationExpected;
    return value && typeof value.title === 'string' && Number.isInteger(value.pageCount) && value.pageCount > 0
      && [0, 1].includes(value.illustType) && remoteDate(value.scheduledAt) === remoteDate(item.scheduledAt)
      && Boolean(remoteDate(item.scheduledAt)) ? value : null;
  }
  function validIndex(index, account) {
    return index?.complete === true && index.pixivUserId === account.pixivUserId && Array.isArray(index.artworkIds)
      && index.artworkIds.length <= 50000 && index.artworkIds.every(id => typeof id === 'string' && /^\d+$/.test(id))
      && new Set(index.artworkIds).size === index.artworkIds.length;
  }
  function hasBaseline(item) {
    return Boolean(remoteDate(item.publicationBaselineAt)) && Date.parse(item.publicationBaselineAt) <= Date.parse(item.scheduledAt) && Array.isArray(item.publishedBaselineIds)
      && item.publishedBaselineIds.length <= 50000 && item.publishedBaselineIds.every(id => typeof id === 'string' && /^\d+$/.test(id));
  }
  async function snapshot(account, context = {}) {
    const items = Object.values(ledger).filter(item => item.accountId === account.id && item.pixivUserId === account.pixivUserId);
    const pending = items.filter(item => item.phase === 'confirmed' && /^illust:\d+$/.test(item.remoteId || '') && !item.publishedId);
    const data = await verify(account, account.browser?.targetId, { includePublishedIndex: pending.length > 0 }), result = normalizeRemote(data);
    const at = new Date(now()).toISOString(), jobs = Array.isArray(context.jobs) ? context.jobs : [];
    let changed = false;
    const checks = [], eligible = [];
    for (const item of pending) {
      const remote = result.reservations.find(row => row.remoteId === item.remoteId);
      // The submitted ledger and exact local reservation identity must agree;
      // an unrelated draft or an edited title cannot supply missing evidence.
      const storedExpected = validExpected(item);
      const hasEvidenceFields = item.publicationExpected && (Object.hasOwn(item.publicationExpected, 'tags') || Object.hasOwn(item.publicationExpected, 'xRestrict'));
      if (!hasEvidenceFields) {
        const boundJobs = jobs.filter(job => job.accountId === account.id && job.id === item.jobId && job.idempotencyKey === item.idempotencyKey
          && job.remoteId === item.remoteId && ['reserved', 'needs_review'].includes(job.status)
          && (!job.pixivUserId || String(job.pixivUserId) === account.pixivUserId));
        const expected = boundJobs.length === 1 ? publicationExpected(boundJobs[0]) : null;
        if (expected && typeof item.title === 'string' && expected.title === item.title && expected.scheduledAt === remoteDate(item.scheduledAt)
          && (!storedExpected || storedExpected.title === expected.title && storedExpected.pageCount === expected.pageCount && storedExpected.illustType === expected.illustType)) {
          if (!storedExpected) {
            // Keep the legacy metadata upgrade, but no new distinguishing
            // evidence without stored page/type metadata to compare against.
            const { tags, xRestrict, ...base } = expected;
            item.publicationExpected = base; changed = true;
          } else if (validPublicationEvidence(expected)) {
            // Remote-flow jobs are immutable through the API. This exact
            // identity link can backfill older records, never replace evidence
            // frozen before a submit or repair/create a missing baseline.
            Object.assign(item.publicationExpected, { tags: expected.tags, xRestrict: expected.xRestrict }); changed = true;
          }
        }
      }
      const expected = validExpected(item);
      if (remote) {
        // A reservation still present in the complete remote list is a safe
        // opportunity to upgrade a legacy ledger before its publication.
        if (expected && Date.parse(at) < Date.parse(expected.scheduledAt) && !hasBaseline(item) && validIndex(data.publicationIndex, account)
          && remote.scheduledAt === expected.scheduledAt && titleMatches(remote.title, expected.title) && remote.pageCount === expected.pageCount) {
          item.publishedBaselineIds = [...data.publicationIndex.artworkIds]; item.publicationBaselineAt = at; changed = true;
        }
        continue;
      }
      if (!(Date.parse(item.scheduledAt) <= Date.parse(at))) continue;
      const report = { jobId: item.jobId, remoteId: item.remoteId, status: 'pending', checkedAt: at };
      checks.push(report);
      if (!expected) { report.reason = 'metadata_missing'; continue; }
      if (!hasBaseline(item)) { report.reason = 'baseline_missing'; continue; }
      if (!validIndex(data.publicationIndex, account)) { report.reason = 'published_index_unavailable'; continue; }
      const baseline = new Set(item.publishedBaselineIds);
      const ids = data.publicationIndex.artworkIds.filter(id => !baseline.has(id));
      if (ids.length > 100) { report.reason = 'candidate_limit'; continue; }
      eligible.push({ item, expected, ids, report });
    }
    // All candidates must be readable before uniqueness can be established.
    // Cache each detail once across the account's at most ten reservations.
    const details = new Map(), candidateIds = [...new Set(eligible.flatMap(entry => entry.ids))];
    if (candidateIds.length > 100) {
      for (const entry of eligible) entry.report.reason = 'candidate_limit';
      eligible.length = 0;
    }
    const deadline = Date.now() + 30000;
    for (const id of eligible.length ? candidateIds : []) {
      if (Date.now() >= deadline) break;
      try {
        const work = await browser.evaluate(readPublished, { artworkId: id, expectedId: account.pixivUserId });
        if (work?.artworkId !== id || work.userId !== account.pixivUserId || typeof work.title !== 'string'
          || !Number.isInteger(work.pageCount) || ![0, 1, 2].includes(work.illustType) || !remoteDate(work.createDate)) throw new Error();
        details.set(id, work);
      } catch { details.set(id, null); break; }
    }
    const claimed = new Set(Object.values(ledger).filter(item => item.pixivUserId === account.pixivUserId).map(item => item.publishedId).filter(Boolean));
    const competing = (entry, work) => Object.values(ledger).filter(other => other !== entry.item && other.pixivUserId === account.pixivUserId
      && ['confirmed', 'unknown', 'submitting'].includes(other.phase) && !other.publishedId
      && !result.reservations.some(row => row.remoteId === other.remoteId)
      && typeof other.title === 'string' && titleMatches(work.title, other.title)
      && Date.parse(remoteDate(work.createDate)) >= Date.parse(other.scheduledAt)
      && Date.parse(remoteDate(work.createDate)) < Date.parse(other.scheduledAt) + 60000
      && (!validExpected(other) || work.pageCount === other.publicationExpected.pageCount && work.illustType === other.publicationExpected.illustType));
    const matches = new Map();
    for (const entry of eligible) {
      if (entry.ids.some(id => !details.get(id))) { entry.report.reason = 'candidate_read_failed'; continue; }
      let match = entry.ids.map(id => details.get(id)).filter(work => !claimed.has(work.artworkId)
        && titleMatches(work.title, entry.expected.title) && work.pageCount === entry.expected.pageCount && work.illustType === entry.expected.illustType
        // createDate is the verified Pixiv publication timestamp. Only the
        // scheduled minute qualifies; checks may occur many hours later.
        && Date.parse(remoteDate(work.createDate)) >= Date.parse(entry.expected.scheduledAt)
        && Date.parse(remoteDate(work.createDate)) < Date.parse(entry.expected.scheduledAt) + 60000
        && Date.parse(remoteDate(work.createDate)) <= Date.parse(at));
      const hasFrozenEvidence = Object.hasOwn(entry.expected, 'tags') || Object.hasOwn(entry.expected, 'xRestrict');
      // Once frozen, distinguishing evidence remains mandatory on every sync.
      // A sibling confirmed on an earlier sync must not let the leftover work
      // bypass a previously observed mismatch or incomplete evidence.
      if (hasFrozenEvidence || match.length > 1 || match.some(work => competing(entry, work).length)) {
        if (!validPublicationEvidence(entry.expected) || match.some(work => !validPublicationEvidence(work))) {
          entry.report.reason = 'publication_evidence_missing'; continue;
        }
        match = match.filter(work => samePublicationEvidence(entry.expected, work));
        if (!match.length) { entry.report.reason = 'publication_evidence_mismatch'; continue; }
      }
      if (match.length !== 1) { entry.report.reason = match.length ? 'ambiguous_match' : 'no_unique_match'; continue; }
      matches.set(entry, match[0]);
    }
    const counts = new Map();
    for (const work of matches.values()) counts.set(work.artworkId, (counts.get(work.artworkId) || 0) + 1);
    for (const [entry, work] of matches) {
      const possibleOtherOwner = competing(entry, work).some(other => !validExpected(other) || !validPublicationEvidence(other.publicationExpected)
        || !validPublicationEvidence(work) || samePublicationEvidence(other.publicationExpected, work));
      if (counts.get(work.artworkId) !== 1 || possibleOtherOwner) { entry.report.reason = 'ambiguous_match'; continue; }
      Object.assign(entry.item, { publishedId: work.artworkId, publicationVerifiedAt: at, publishedAt: remoteDate(work.createDate), phase: 'published' });
      entry.report.status = 'published'; entry.report.artworkId = work.artworkId; changed = true;
    }
    for (const report of checks) {
      const item = items.find(item => item.jobId === report.jobId && item.remoteId === report.remoteId);
      if (item) { item.publicationCheck = { ...report }; changed = true; }
    }
    if (changed) await save();
    if (checks.length) result.publicationChecks = checks;
    for (const item of items) {
      const remote = result.reservations.find(r => r.remoteId === item.remoteId);
      if (remote) Object.assign(remote, { jobId: item.jobId, idempotencyKey: item.idempotencyKey });
      // A separately verified final artwork ID is required after a reservation
      // disappears. Neither elapsed time nor a missing row proves publication.
      if (!remote && item.publishedId && item.publicationVerifiedAt) {
        result.reservations.push({ remoteId: item.remoteId, jobId: item.jobId, idempotencyKey: item.idempotencyKey,
          status: 'published', scheduledAt: item.scheduledAt, artworkId: item.publishedId, pixivUserId: account.pixivUserId,
          publishedAt: item.publishedAt || item.publicationVerifiedAt, publicationVerifiedAt: item.publicationVerifiedAt });
      }
    }
    if (Array.isArray(context.jobs)) {
      try {
        const avatar = await browser.evaluate(readAccountAvatar, { expectedId: account.pixivUserId });
        if (avatar?.pixivUserId === account.pixivUserId && avatar.avatarUrl) result.avatarUrl = avatar.avatarUrl;
      } catch { /* Avatar lookup cannot invalidate an otherwise verified queue snapshot. */ }
    }
    return result;
  }
  async function newForm(account, job, key) {
    await verify(account);
    const existingTargets = new Set((await browser.tabs()).map(tab => tab.targetId));
    const tab = await browser.openTab(`https://www.pixiv.net/${job.content.type === 'manga' ? 'manga' : 'illustration'}/create`);
    if (!pixiv(tab)) reject('无法创建 Pixiv 投稿标签页。');
    ledger[key].targetId = tab.targetId;
    if (!existingTargets.has(tab.targetId) && tab.targetId !== account.browser?.targetId) ledger[key].ownedTargetId = tab.targetId;
    await save();
    let identity;
    for (let attempt = 0; attempt < 12; attempt++) {
      await browser.select(tab.targetId);
      try { identity = await browser.evaluate(readIdentity); if (identity.loggedIn) break; } catch {}
      await delay(400);
    }
    if (!identity?.loggedIn || identity.pixivUserId !== account.pixivUserId) reject('新标签页的 Pixiv 账号不匹配；未填写任何投稿内容。', 'identity_mismatch');
    // Server-rendered identity can arrive before the redirected form hydrates.
    await browser.command(['wait', '--fn', `document.readyState === 'complete' && ['input[name="title"]','input[name="x_restrict"]','input[name="reserve"]'].every(selector => { const e = document.querySelector(selector); return e && Object.keys(e).some(k => k.startsWith('__reactProps')); })`]);
    return tab;
  }
  async function preflight(account, job) {
    const issues = unsupportedFields(job);
    const validation = validateJob(job, { now: new Date(now()).toISOString() });
    const remote = await snapshot(account);
    return { checkedAt: new Date(now()).toISOString(), connected: true, pixivUserId: account.pixivUserId,
      name: remote.name, premium: remote.premium, reserved: remote.total,
      ready: remote.premium && remote.total < 10 && issues.length === 0 && validation.valid,
      issues: [...(!remote.premium ? ['账号未开通 Premium。'] : []), ...(remote.total >= 10 ? ['预约名额已满。'] : []),
        ...issues.map(field => `${field}尚未完成浏览器适配，请在 Pixiv 手动设置。`), ...validation.errors.map(e => e.message)] };
  }
  async function prepare(account, job, files, key) {
    const check = await preflight(account, job);
    if (!check.ready) reject(check.issues.join(' '), check.reserved >= 10 ? 'capacity_full' : 'unsupported_fields');
    const when = Date.parse(job.scheduledAt), at = +new Date(now());
    if (!(when > at && when <= at + 7*86400000) || when % 1800000 !== 0) reject('预约时间须在未来一周内，且为整点或半点。');
    const tab = await newForm(account, job, key);
    const run = async (...args) => { await browser.select(tab.targetId); return browser.command(args); };
    const set = async (name, value) => run(value ? 'check' : 'uncheck', `input[name="${name}"]`);
    const c = job.content;
    await run('fill', 'input[name="title"]', job.title);
    await run('fill', 'textarea[name="comment"]', job.caption || '');
    await run('check', `input[name="x_restrict"][value="${c.rating === 'all' ? 'general' : c.rating}"]`);
    if (c.rating === 'all') await run('check', `input[name="sexual"][value="${c.sexualContent}"]`);
    await run('check', `input[name="ai_type"][value="${c.aiGenerated ? 'aiGenerated' : 'notAiGenerated'}"]`);
    await run('check', `input[name="restrict"][value="${c.visibility === 'logged_in' ? 'loginOnly' : c.visibility}"]`);
    await run('check', `input[name="allow_comment"][value="${c.allowComments}"]`);
    await set('allow_tag_edit', !c.allowTagEdit); await set('allow-citation', c.allowCollection); await set('original', c.original);
    const tags = [...new Set([...job.tags, ...(c.contestTag ? [c.contestTag] : [])])];
    if (tags.length > 10) reject('标签与企划标签合计超过 10 个。');
    // The tag editor limits each input to 30 characters; blur commits one chip.
    for (const tag of tags) {
      await run('fill', 'input[placeholder="标签"]', tag);
      await run('click', 'input[name="title"]');
    }
    await set('reserve', true);
    const labels = scheduleLabels(job.scheduledAt);
    for (const kind of ['date','time']) {
      let phase = 'open', result, chosen = false;
      // Opening and choosing are one-shot actions. Poll the DOM after each;
      // clicking the control again while a menu renders would close it.
      for (let attempt = 0; attempt < 30; attempt++) {
        result = await browser.evaluate(chooseSchedule, { kind, text: labels[kind], phase });
        const status = typeof result === 'string' ? result : result?.status;
        if (status === 'chosen') { chosen = true; break; }
        if (['unavailable', 'ambiguous'].includes(status)) break;
        if (status === 'selected') phase = 'verify';
        else if (status === 'opened') phase = 'select';
        if (attempt < 29) await delay(200);
      }
      if (!chosen) {
        const field = kind === 'date' ? '日期' : '时间';
        const reason = result?.status === 'unavailable' ? '控件不可用' : result?.status === 'ambiguous' ? '匹配到多个选项' : phase === 'verify' ? '选择后未得到页面确认' : '等待选项显示超时';
        const current = typeof result?.current === 'string' && result.current ? `，页面当前为 ${result.current}` : '';
        reject(`Pixiv 预约${field}选择失败：${reason}。目标为 ${labels[kind]}${current}；尚未上传图片。`, 'schedule_selection_failed');
      }
    }
    // Upload only trusted paths resolved by the application, never paths supplied
    // by an HTTP caller. The form is owned by this application.
    await run('upload', 'input[name="files[]"]', ...files);
    let form;
    for (let attempt = 0; attempt < 30; attempt++) { form = await browser.evaluate(readForm); if (form.submitEnabled) break; await delay(500); }
    const get = name => form.fields.find(f => f.name === name && (f.type !== 'radio' || f.checked));
    const matches = get('title')?.value === job.title && get('comment')?.value === (job.caption || '') &&
      get('x_restrict')?.value === (c.rating === 'all' ? 'general' : c.rating) &&
      get('ai_type')?.value === (c.aiGenerated ? 'aiGenerated' : 'notAiGenerated') &&
      get('restrict')?.value === (c.visibility === 'logged_in' ? 'loginOnly' : c.visibility) &&
      get('allow_comment')?.value === String(c.allowComments) && get('allow_tag_edit')?.checked === !c.allowTagEdit &&
      get('allow-citation')?.checked === c.allowCollection && get('original')?.checked === c.original && get('reserve')?.checked &&
      (c.rating !== 'all' || get('sexual')?.value === String(c.sexualContent)) &&
      form.scheduleLabels.includes(labels.date) && form.scheduleLabels.includes(labels.time) &&
      JSON.stringify(form.tags) === JSON.stringify(tags) && form.imageCount === files.length;
    if (!matches || !form.submitEnabled) reject('投稿表单回读未通过，已保留页面，请检查；尚未点击投稿。', 'form_mismatch');
    ledger[key] = { ...ledger[key], targetId: tab.targetId, phase: 'prepared', preparedAt: new Date(now()).toISOString() };
    await save();
    return { tab, form };
  }
  async function reserve(account, job, files, idempotencyKey, controls = {}) {
    const key = createHash('sha256').update(idempotencyKey).digest('hex');
    const previous = ledger[key];
    if (previous) {
      if (previous.accountId !== account.id || previous.pixivUserId !== account.pixivUserId || previous.jobId !== job.id) reject('提交记录与当前账号或作品不符。', 'identity_mismatch');
      if (previous.remoteId) return { reservation: { remoteId: previous.remoteId, status: 'reserved' } };
      return { error: '此作品已有未确认的浏览器提交记录，请核对原页面，不会自动重复投稿。' };
    }
    if (account.browser?.postingEnabled !== true) return { definitive: true, outcome: 'not_uploaded', error: '请在账号管理中启用此账号的浏览器投稿。' };
    ledger[key] = { accountId: account.id, pixivUserId: account.pixivUserId, jobId: job.id, idempotencyKey, publicationExpected: publicationExpected(job, files.length),
      scheduledAt: job.scheduledAt, title: job.title, phase: 'preparing', createdAt: new Date(now()).toISOString() };
    await save();
    let submitted = false;
    const checkStopped = () => {
      if (typeof controls.shouldStop === 'function' && controls.shouldStop()) reject('预约已暂停，尚未提交。', 'reservation_paused');
    };
    try {
      checkStopped();
      const { tab, form } = await prepare(account, job, files, key);
      return await submitForAccount(account, async () => {
        checkStopped();
        if (Object.entries(ledger).some(([otherKey, item]) => otherKey !== key && item.pixivUserId === account.pixivUserId && ['submitting', 'unknown'].includes(item.phase))) {
          reject('同账号存在未确认的投稿结果，请先核对；本作品尚未提交。', 'reservation_paused');
        }
        const beforeData = await verify(account, tab.targetId, { includePublishedIndex: true }), before = normalizeRemote(beforeData);
        if (!validIndex(beforeData.publicationIndex, account)) reject('无法保存发布核验所需的作品基线，尚未提交预约。请稍后重试。', 'publication_baseline_unavailable');
        if (before.total >= 10) reject('提交前名额已满，尚未投稿。', 'capacity_full');
        if (Date.parse(job.scheduledAt) <= +new Date(now())) reject('提交前预约时间已过，尚未投稿。');
        if (JSON.stringify(await browser.evaluate(readForm)) !== JSON.stringify(form)) reject('提交前表单发生变化，尚未点击投稿，请重新检查。', 'form_changed');
        ledger[key].beforeIds = before.reservations.map(r => r.remoteId);
        if (validIndex(beforeData.publicationIndex, account)) {
          ledger[key].publishedBaselineIds = [...beforeData.publicationIndex.artworkIds];
          ledger[key].publicationBaselineAt = new Date(now()).toISOString();
        }
        ledger[key].phase = 'submitting'; await save();
        // A pause received during form preparation takes effect before the one
        // irreversible click. Once clicked, finish verification as usual.
        checkStopped();
        submitted = true; // Any transport error from this point is ambiguous.
        const click = await browser.evaluate(clickSubmit);
        if (click?.clicked === false) { submitted = false; reject('投稿按钮不可用，尚未点击投稿。', 'submit_unavailable'); }
        for (let attempt = 0; attempt < 20; attempt++) {
          await delay(1000);
          // The submitting tab redirects on success; use the stable bound tab.
          const after = normalizeRemote(await verify(account));
          const added = after.reservations.filter(r => r.kind === 'illust' && !ledger[key].beforeIds.includes(r.remoteId) && titleMatches(r.title,job.title) && r.scheduledAt === new Date(job.scheduledAt).toISOString() && r.pageCount === files.length
            && !Object.entries(ledger).some(([otherKey, item]) => otherKey !== key && item.pixivUserId === account.pixivUserId && item.remoteId === r.remoteId));
          if (added.length === 1) {
            Object.assign(ledger[key], { remoteId: added[0].remoteId, phase: 'confirmed', confirmedAt: new Date(now()).toISOString() });
            await save();
            await closeConfirmedForm(key, account);
            return { reservation: { remoteId: added[0].remoteId, status: 'reserved' } };
          }
          if (added.length > 1) break;
        }
        reject('Pixiv 提交结果尚未唯一确认，请核对作品管理页面。不会重复提交。', 'outcome_unknown');
      });
    } catch (e) {
      ledger[key].phase = submitted ? 'unknown' : 'not_submitted'; ledger[key].error = e.message; await save();
      return submitted ? { error: e.message } : { definitive: true, outcome: 'not_uploaded', ...(e.code === 'reservation_paused' ? { paused: true } : {}),
        ...(e.code === 'capacity_full' ? { capacityBlocked: true } : {}), error: e.message };
    }
  }
  const api = {
    close: async () => {
      sharedBrowser.close?.();
      const entries = [...dedicatedBrowsers.values()]; dedicatedBrowsers.clear();
      await Promise.all(entries.map(entry => entry.ready.then(value => value.driver.close?.()).catch(() => {})));
    },
    openDedicatedLogin: account => atomic(async () => {
      if (!account?.id || !/^\d+$/.test(account.pixivUserId || '')) reject('请先设置此账号的 Pixiv ID。', 'unbound');
      if (!dedicatedChrome?.showLogin) reject('尚未配置专用 Chrome 管理器。', 'dedicated_unavailable');
      await releaseDedicated(account);
      const opened = dedicatedSession(await dedicatedChrome.showLogin(account));
      return { mode: opened.mode, loginPending: true };
    }),
    verifyDedicated: account => atomic(() => {
      const dedicated = { ...account, browser: { ...account.browser, mode: 'dedicated' } };
      return inAccount(dedicated, () => verifyDedicatedAccount(dedicated));
    }),
    backgroundDedicated: account => atomic(async () => {
      if (!dedicatedChrome?.finishLogin) reject('尚未配置专用 Chrome 管理器。', 'dedicated_unavailable');
      const dedicated = { ...account, browser: { ...account.browser, mode: 'dedicated' } };
      await inAccount(dedicated, () => verifyDedicatedAccount(dedicated));
      await releaseDedicated(dedicated);
      dedicatedSession(await dedicatedChrome.finishLogin(dedicated));
      return inAccount(dedicated, () => verifyDedicatedAccount(dedicated));
    }),
    discover: () => atomic(async () => {
      const tabs = (await browser.tabs()).filter(pixiv), accounts = [], errors = [];
      candidates = new Map();
      for (const tab of tabs) {
        try {
          await browser.select(tab.targetId);
          const identity = await browser.evaluate(readIdentity);
          if (!identity.loggedIn) continue;
          const verified = await browser.evaluate(readRemote, { expectedId: identity.pixivUserId });
          if (accounts.some(a => a.pixivUserId === verified.identity.pixivUserId)) continue;
          const candidate = { ...verified.identity, candidateId: randomUUID(), targetId: tab.targetId, checkedAt: new Date(now()).toISOString() };
          candidates.set(candidate.candidateId, candidate); accounts.push(candidate);
        } catch (e) { errors.push({ message: e.message }); }
      }
      return { accounts, errors, checkedAt: new Date(now()).toISOString(), message: accounts.length ? `已识别 ${accounts.length} 个 Pixiv 账号。` : '未找到可验证的登录账号。请在已允许远程调试的 Chrome 中打开 Pixiv。' };
    }),
    bind: (account, candidateId) => atomic(async () => {
      const candidate = candidates.get(candidateId);
      if (!candidate || +new Date(now()) - Date.parse(candidate.checkedAt) > 10*60000) reject('浏览器账号列表已过期，请重新检测。');
      if (account.pixivUserId && account.pixivUserId !== candidate.pixivUserId) reject('所选浏览器账号与填写的 Pixiv ID 不一致。', 'identity_mismatch');
      const next = { ...account, pixivUserId: candidate.pixivUserId, browser: { targetId: candidate.targetId, postingEnabled: false, boundAt: new Date(now()).toISOString() } };
      const remote = await snapshot(next);
      return { account: next, snapshot: remote };
    }),
    snapshot: (account, context) => atomic(() => snapshot(account, context)),
    analytics: (account, { artworkIds, includeIndex = false, includeAccount = false, bulk = false, offset, limit = 1000 } = {}) => atomic(async () => {
      if ((!account?.browser?.targetId && !isDedicated(account)) || !/^\d+$/.test(account.pixivUserId || '')) reject('请先为该账号连接 Chrome，才能读取统计数据。', 'unbound');
      if (artworkIds !== undefined && (!Array.isArray(artworkIds) || artworkIds.length > 10 || artworkIds.some(id => typeof id !== 'string' || !/^\d+$/.test(id)))) reject('统计作品批次无效。', 'invalid_batch');
      if (bulk && artworkIds !== undefined) reject('统计批量读取和指定作品读取不能同时使用。', 'invalid_batch');
      if (bulk && (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0 || offset > 50000)
        || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000)) reject('统计分页参数无效。', 'invalid_batch');
      const requested = [...new Set(artworkIds || [])];
      const result = { pixivUserId: account.pixivUserId, artworks: [], index: null, account: null, complete: true,
        attemptedArtworkIds: [], failedArtworkIds: [], remainingArtworkIds: requested, errors: [], rateLimited: false, retryAfterSeconds: 0,
        capabilities: { artworkDetails: true, publishedIndex: true, bulkWorks: true, accountSummary: true } };
      const finish = () => ({ ...result, observedAt: new Date(now()).toISOString() });
      if (Date.now() < analyticsResumeAfter) return { ...finish(), complete: false, rateLimited: true,
        retryAfterSeconds: Math.ceil((analyticsResumeAfter - Date.now()) / 1000), errors: [{ phase: 'request', code: 'rate_limited' }] };
      await selectAccount(account);
      const merge = value => {
        if (!value || value.pixivUserId !== account.pixivUserId || !Array.isArray(value.errors) || !Array.isArray(value.artworks)) reject('Pixiv 统计返回的账号或数据格式不符。', 'analytics_invalid');
        if (value.errors.some(error => error?.code === 'identity_mismatch')) reject('当前 Pixiv 账号与绑定 ID 不符，已停止统计读取。', 'identity_mismatch');
        if (value.artworks.some(work => work?.userId !== account.pixivUserId || typeof work.artworkId !== 'string' || !/^\d+$/.test(work.artworkId)
          || !bulk && !requested.includes(work.artworkId))) reject('Pixiv 统计作品与绑定账号或请求不符。', 'analytics_invalid');
        if (value.index && (value.index.pixivUserId !== account.pixivUserId || value.index.complete !== true || !Array.isArray(value.index.artworkIds)
          || value.index.artworkIds.length > 50000 || value.index.total !== value.index.artworkIds.length || new Set(value.index.artworkIds).size !== value.index.artworkIds.length
          || value.index.artworkIds.some(id => typeof id !== 'string' || !/^\d+$/.test(id)))) reject('Pixiv 统计作品索引格式无效。', 'analytics_invalid');
        if (value.account && value.account.pixivUserId !== account.pixivUserId) reject('Pixiv 统计账号不符。', 'analytics_invalid');
        result.artworks.push(...value.artworks);
        if (value.index) result.index = value.index;
        if (value.account) result.account = value.account;
        result.errors.push(...value.errors); result.complete &&= value.complete === true;
        const limited = value.rateLimited === true || value.errors.some(error => error?.httpStatus === 429);
        if (limited) {
          result.rateLimited = true;
          result.retryAfterSeconds = Math.max(60, ...value.errors.map(error => Number.isFinite(error?.retryAfterSeconds) ? Math.min(86400, Math.max(0, error.retryAfterSeconds)) : 0));
          analyticsResumeAfter = Math.max(analyticsResumeAfter, Date.now() + result.retryAfterSeconds * 1000);
        }
        return value.errors.some(error => error?.phase === 'identity') || limited;
      };
      if (includeIndex || includeAccount) {
        if (merge(await browser.evaluate(readAnalyticsOverview, { expectedId: account.pixivUserId, includeIndex: includeIndex === true, includeAccount: includeAccount === true }))) return finish();
      }
      if (bulk === true) {
        const value = await browser.evaluate(readAnalyticsWorksPage, { expectedId: account.pixivUserId, ...(offset !== undefined ? { offset } : {}), limit });
        merge(value);
        for (const name of ['attemptedArtworkIds', 'failedArtworkIds', 'remainingArtworkIds']) {
          if (!Array.isArray(value[name]) || value[name].some(id => typeof id !== 'string' || !/^\d+$/.test(id))) reject('Pixiv 统计读取进度格式无效。', 'analytics_invalid');
          result[name] = value[name];
        }
        for (const name of ['page', 'fetchRanges', 'nextRange', 'total', 'source']) result[name] = value[name] ?? null;
        if (result.index && result.total !== null && (result.total !== result.index.total || result.artworks.some(work => !result.index.artworkIds.includes(work.artworkId)))) {
          result.complete = false; result.errors.push({ phase: 'bulk', code: 'index_mismatch' });
        }
        return finish();
      }
      if (artworkIds !== undefined) {
        const value = await browser.evaluate(readArtworkAnalytics, { expectedId: account.pixivUserId, artworkIds: requested });
        merge(value);
        for (const name of ['attemptedArtworkIds', 'failedArtworkIds', 'remainingArtworkIds']) {
          if (!Array.isArray(value[name]) || value[name].some(id => !requested.includes(id))) reject('Pixiv 统计读取进度格式无效。', 'analytics_invalid');
          result[name] = value[name];
        }
      }
      return finish();
    }),
    searchTags: (account, words, { includeHistory = false, historyLimit, fullHistory = false, historyOffset = 0, historyTimeBudgetMs = 120000 } = {}) => atomic(async () => {
      if (!account?.browser?.targetId && !isDedicated(account)) reject('请先为该账号连接 Chrome，才能匹配 Pixiv 全站标签。');
      await selectAccount(account);
      const selectedWords = [...new Set(words)].slice(0, 256);
      if (includeHistory !== true || fullHistory !== true) return browser.evaluate(readTags, {expectedId:account.pixivUserId,words:selectedWords,includeHistory:includeHistory === true,
        ...(includeHistory === true && Number.isInteger(historyLimit) ? {historyLimit:Math.max(1,Math.min(60,historyLimit))} : {})});
      const startedAt = Date.now();
      const budget = Number.isSafeInteger(historyTimeBudgetMs) ? Math.max(1000, Math.min(120000, historyTimeBudgetMs)) : 120000;
      const deadline = startedAt + budget;
      const offset = Number.isSafeInteger(historyOffset) ? Math.max(0, historyOffset) : 0;
      const limit = Number.isSafeInteger(historyLimit) ? Math.max(1, Math.min(2000, historyLimit)) : 2000;
      if (!await historySlot(deadline)) reject('历史同步正在等待读取间隔，请稍后继续。', 'history_wait');
      let result;
      try { result = await browser.evaluate(readTags, { expectedId: account.pixivUserId, words: selectedWords, includeHistory: false }); }
      finally { historyFinishedAt = Date.now(); }
      const scan = { source: 'pixiv-profile-all', total: null, offset, nextOffset: offset, limit, attempted: 0, succeeded: 0, failed: 0,
        failedArtworkIds: [], errorCounts: {}, truncated: true, completed: false, complete: false };
      function recordError(error, phase) {
        const report = safeHistoryError(error, phase);
        if (report.httpStatus === 429 || scan.lastError?.httpStatus !== 429) scan.lastError = report;
        if (report.httpStatus === 429 && report.retryAfterSeconds) historyResumeAfter = Math.max(historyResumeAfter, Date.now() + report.retryAfterSeconds * 1000);
        const key = report.httpStatus ? `${report.code}:${report.httpStatus}` : report.code;
        scan.errorCounts[key] = (scan.errorCounts[key] || 0) + 1;
        return report;
      }
      result.recentWorks = [];
      result.historyScan = scan;
      try {
        let index;
        try { index = await browser.evaluate(readPublishedHistory, { expectedId: account.pixivUserId, historyOffset: offset, historyLimit: limit }); }
        finally { historyFinishedAt = Date.now(); }
        if (index?.historyError) { recordError(index.historyError, 'index'); throw new Error('history_index_unavailable'); }
        if (index?.pixivUserId !== account.pixivUserId || !Number.isSafeInteger(index.total) || index.total < 0
          || !Array.isArray(index.artworkIds) || index.artworkIds.length > limit
          || index.artworkIds.some(id => typeof id !== 'string' || !/^\d+$/.test(id))) {
          recordError({ code: 'schema_changed' }, 'index'); throw new Error('history_index_invalid');
        }
        scan.total = index.total;
        const ids = [...new Set(index.artworkIds)];
        let cursor = 0;
        while (cursor < ids.length && Date.now() - startedAt < budget) {
          if (!await historySlot(deadline)) { scan.stoppedReason = 'time_budget'; break; }
          const batchIds = ids.slice(cursor, cursor + 10);
          let batch;
          try {
            try { batch = await browser.evaluate(readPublishedHistory, { expectedId: account.pixivUserId, artworkIds: batchIds }); }
            finally { historyFinishedAt = Date.now(); }
            if (batch?.historyError) {
              const error = recordError(batch.historyError, 'detail');
              scan.stoppedReason = error.httpStatus === 429 ? 'rate_limited' : 'batch_unavailable';
              break;
            }
            if (batch?.pixivUserId !== account.pixivUserId || !Array.isArray(batch.recentWorks) || !Array.isArray(batch.attemptedArtworkIds)
              || !Array.isArray(batch.failedArtworkIds) || !Array.isArray(batch.remainingArtworkIds)
              || batch.attemptedArtworkIds.some(id => !batchIds.includes(id)) || batch.failedArtworkIds.some(id => !batch.attemptedArtworkIds.includes(id))
              || batch.recentWorks.some(work => !batch.attemptedArtworkIds.includes(work.artworkId))) throw Object.assign(new Error('history_batch_invalid'), { code: 'schema_changed' });
          } catch (error) {
            if (/登录账号发生变化|绑定的 Pixiv 账号/.test(error.message)) throw error;
            recordError(error, 'detail');
            scan.attempted += batchIds.length;
            scan.failedArtworkIds.push(...batchIds);
            cursor += batchIds.length;
            scan.stoppedReason = 'batch_unavailable';
            break;
          }
          result.recentWorks.push(...batch.recentWorks);
          for (const error of (Array.isArray(batch.historyErrors) ? batch.historyErrors : []).slice(0, 10)) recordError(error, 'detail');
          scan.attempted += batch.attemptedArtworkIds.length;
          scan.failedArtworkIds.push(...batch.failedArtworkIds);
          cursor += batch.attemptedArtworkIds.length;
          if (batch.remainingArtworkIds.length || batch.rateLimited) {
            scan.stoppedReason = batch.rateLimited ? 'rate_limited' : 'batch_time_budget';
            break;
          }
          if (batch.attemptedArtworkIds.length !== batchIds.length) { scan.stoppedReason = 'incomplete_batch'; break; }
        }
        scan.nextOffset = offset + cursor;
        scan.remaining = Math.max(0, scan.total - scan.nextOffset);
        scan.truncated = scan.nextOffset < scan.total;
        if (scan.truncated && !scan.stoppedReason) scan.stoppedReason = cursor < ids.length ? 'time_budget' : 'work_limit';
      } catch (error) {
        if (/登录账号发生变化|绑定的 Pixiv 账号/.test(error.message)) throw error;
        if (!scan.lastError) recordError(error, 'index');
        scan.stoppedReason = scan.lastError?.httpStatus === 429 ? 'rate_limited' : 'index_unavailable';
      }
      scan.failedArtworkIds = [...new Set(scan.failedArtworkIds)];
      scan.failed = scan.failedArtworkIds.length;
      scan.succeeded = result.recentWorks.length;
      scan.completed = scan.complete = scan.total !== null && !scan.truncated && scan.failed === 0 && !scan.stoppedReason;
      scan.checkedAt = new Date(now()).toISOString();
      if (!scan.completed) result.historyWarning = scan.total === null ? '暂时无法核对完整历史作品列表；原有历史记录已保留。'
        : `本次已核对 ${scan.succeeded} 件历史作品，${scan.failed} 件读取失败，另有 ${scan.remaining || 0} 件尚未读取；原有历史记录已保留。`;
      if (scan.lastError) result.historyWarning = `${result.historyWarning || ''}${historyErrorMessage(scan.lastError)}`;
      const normalized = value => value.normalize('NFKC').toLowerCase().replace(/[ _]/g, '');
      for (const work of result.recentWorks) for (const tag of work.tags) for (const word of selectedWords) {
        if (normalized(tag) === normalized(word) && !result.matches.some(match => match.word === word && match.tag === tag)) {
          result.matches.push({ word, tag, count: null, url: `https://www.pixiv.net/artworks/${work.artworkId}` });
        }
      }
      return result;
    }),
    preflight: (account, job) => atomic(() => preflight(account, job)),
    reconcile: (account, job, input) => atomic(async () => {
      if (!job.idempotencyKey) reject('这件作品没有浏览器提交记录。');
      const key = createHash('sha256').update(job.idempotencyKey).digest('hex'), item = ledger[key];
      if (!item || item.accountId !== account.id || item.jobId !== job.id || item.pixivUserId !== account.pixivUserId) reject('找不到相符的浏览器提交记录。');
      const current = await snapshot(account);
      if (input.remoteId) {
        const remote = current.reservations.find(r => r.remoteId === input.remoteId && r.status === 'reserved');
        if (!remote || !titleMatches(remote.title,job.title) || !remote.scheduledAt || remote.pageCount !== job.files.length) reject('所选远端预约的标题、时间或图片数量与本地作品不符。');
        const adopt = input.adoptRemoteSchedule === true;
        if (adopt && (item.remoteId !== remote.remoteId || job.remoteId !== remote.remoteId)) reject('只有已关联的同一预约才能采用远端的新时间。');
        if (!adopt && remote.scheduledAt !== new Date(job.scheduledAt).toISOString()) reject('远端时间与本地不同，请明确选择采用远端排期。');
        if (Object.values(ledger).some(other => other !== item && other.accountId === account.id && other.remoteId === remote.remoteId)) reject('此远端预约已关联另一件本地作品。');
        item.remoteId = remote.remoteId; item.phase = 'confirmed'; item.confirmedAt ||= new Date(now()).toISOString();
        if (adopt) item.scheduledAt = remote.scheduledAt;
        const expected = publicationExpected({ ...job, scheduledAt: item.scheduledAt });
        if (expected && item.publicationExpected && (Object.hasOwn(item.publicationExpected, 'tags') || Object.hasOwn(item.publicationExpected, 'xRestrict'))) {
          delete expected.tags; delete expected.xRestrict;
          for (const field of ['tags', 'xRestrict']) if (Object.hasOwn(item.publicationExpected, field)) expected[field] = clone(item.publicationExpected[field]);
        }
        item.title = job.title; item.publicationExpected = expected;
      } else {
        const url = String(input.artworkUrl || '');
        const match = /^https:\/\/www\.pixiv\.net\/(?:[a-z]{2}\/)?artworks\/(\d+)\/?$/.exec(url);
        if (!match) reject('请填写完整的 Pixiv 作品链接。');
        const published = await browser.evaluate(readPublished, { artworkId: match[1], expectedId: account.pixivUserId });
        if (!titleMatches(published.title,job.title) || published.pageCount !== job.files.length) reject('远端作品的标题或图片数量与本地记录不符。');
        if (Object.values(ledger).some(other => other !== item && other.accountId === account.id && other.publishedId === published.artworkId)) reject('此 Pixiv 作品已关联另一件本地作品。');
        item.publishedId = published.artworkId; item.publishedAt = remoteDate(published.createDate) || new Date(now()).toISOString();
        item.publicationVerifiedAt = new Date(now()).toISOString();
        item.remoteId ||= `artwork:${published.artworkId}`; item.phase = 'published';
      }
      await save(); return snapshot(account);
    }),
    reserve: (account, job, files, key, controls) => {
      return inAccount(account, () => reserve(account, job, files, key, controls), { reservation: true });
    },
  };
  for (const method of ['snapshot', 'analytics', 'searchTags', 'preflight', 'reconcile']) {
    const operation = api[method];
    api[method] = (account, ...args) => inAccount(account, () => operation(account, ...args));
  }
  return api;
}
