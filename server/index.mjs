import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { createDemoState, blankState } from './seed.mjs';
import { planReservations, reconcileRemote, validateJob, isCompleteRemoteSnapshot } from './queue.mjs';
import { createTagger } from './tagger.mjs';
import { createBrowserConnector } from './browser-connector.mjs';
import { createDedicatedChrome } from './dedicated-chrome.mjs';
import { tagQueries, rankPixivTags, selectAutomaticTags, annotateTagCandidates } from './recognition.mjs';
import { defaultPostingTime, nextPostingSchedule } from './scheduling.mjs';
import { createCharacterMemory } from './character-memory.mjs';
import { applyCharacterMemory } from './character-recall.mjs';
import { createTagPools, normalizePoolTag } from './tag-pool.mjs';
import { planManualCharacterTags, resolveManualCharacterTags } from './manual-character-tags.mjs';
import { buildCharacterCatalog, composePostingTemplate } from './posting-templates.mjs';
import { QUEUE_CHECK_INTERVAL_MS, QUEUE_PARALLEL_LIMIT, nextQueueCheck, summarizeQueueRun, publicationReviewAccountIds } from './queue-automation.mjs';
import { normalizeAvatarUrl, fetchAvatar } from './account-avatar.mjs';
import { fetchArtworkThumbnail } from './artwork-thumbnail.mjs';
import { createAnalyticsStore } from './analytics.mjs';
import { createAnalyticsCollector, analyticsAccountKey } from './analytics-collector.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JSON_LIMIT = 1024 * 1024;
const IMAGE_LIMIT = 32 * 1024 * 1024;
const WORK_LIMIT = 200 * 1024 * 1024;
const EDITABLE = new Set(['draft', 'queued', 'cancelled']);
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.ico': 'image/x-icon' };
const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

class ApiError extends Error {
  constructor(status, message, details) { super(message); this.status = status; this.details = details; }
}
const fail = (message, status = 400, details) => { throw new ApiError(status, message, details); };
const clone = value => structuredClone(value);
const own = (value, key) => Object.hasOwn(value, key);
function object(value, label = '请求') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label}必须是对象。`);
  return value;
}
function string(value, label, max = 200, empty = true) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) fail(`${label}格式无效（最多 ${max} 字）。`);
  return value.trim();
}
function bool(value, label) { if (typeof value !== 'boolean') fail(`${label}必须是布尔值。`); return value; }
function postingTime(value) { if(typeof value!=='string'||!/^(?:[01]\d|2[0-3]):(?:00|30)$/.test(value))fail('默认投稿时间必须为日本时间的整点或半点。');return value; }
function enumValue(value, list, label) { if (!list.includes(value)) fail(`${label}无效。`); return value; }
function timezone(value) {
  string(value, '时区', 80, false);
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(); } catch { fail('请选择有效时区。'); }
  return value;
}
function log(state, message, level = 'info', now = new Date().toISOString()) {
  state.logs.unshift({ id: randomUUID(), at: now, level, message, demo: state.settings.demo });
  state.logs = state.logs.slice(0, 300);
}

// A work can leave the local list only while its upload outcome is certain.
// Read current remote evidence as well as the job: a stale local status must
// never discard the link needed to reconcile a real Pixiv reservation.
export function localJobDeletionReason(job, state) {
  if (!job || !['draft', 'queued', 'cancelled', 'failed'].includes(job.status)) return '作品已进入远端流程或结果尚待核对，不能在本机删除。';
  const hasRemoteIdentity = record => ['remoteId', 'artworkId', 'publishedId', 'artworkUrl', 'remoteUrl', 'remoteURL', 'publishedAt', 'reservedAt', 'remoteScheduledAt'].some(key => Boolean(record?.[key]));
  if (hasRemoteIdentity(job)) return '作品已有 Pixiv 记录，不能在本机删除。';
  const remoteRecords = state.accounts.filter(account => account.id === job.accountId).flatMap(account => account.remote?.reservations ?? []);
  const effectiveKey = job.idempotencyKey || `pixiv-reservation:${encodeURIComponent(job.accountId)}:${encodeURIComponent(job.id)}:v${job.reservationAttempt || 1}`;
  if (remoteRecords.some(record => record && (record.jobId === job.id || record.idempotencyKey === effectiveKey)
    && (hasRemoteIdentity(record) || record.id || !['failed', 'cancelled'].includes(record.status)))) return 'Pixiv 快照中已有此作品的记录，请先核对远端状态。';
  const notUploaded = job.uploadOutcome === 'not_uploaded';
  if (job.status === 'failed' && !notUploaded) return '上传失败的结果尚未确认，不能删除。';
  if (!notUploaded && (job.uploadStartedAt || job.lastAttemptAt || job.idempotencyKey || job.uploadOutcome)) return '作品曾开始上传，需先确认没有上传到 Pixiv。';
  return '';
}
async function body(req, limit) {
  if (Number(req.headers['content-length']) > limit) fail('上传内容超过大小限制。', 413);
  let size = 0;
  const parts = [];
  for await (const part of req) { size += part.length; if (size > limit) fail('上传内容超过大小限制。', 413); parts.push(part); }
  return Buffer.concat(parts);
}
async function jsonBody(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) fail('请使用 application/json 请求。', 415);
  const data = await body(req, JSON_LIMIT);
  try { return object(JSON.parse(data.toString('utf8'))); } catch (error) { if (error instanceof ApiError) throw error; fail('JSON 格式无效。'); }
}
function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

// Parse image structure, rather than accepting a file extension or claimed MIME type.
export function identifyImage(data) {
  if (data.length >= 45 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    let offset = 8, ihdr = false, idat = false, ended = false;
    while (offset + 12 <= data.length) {
      const length = data.readUInt32BE(offset), type = data.toString('ascii', offset + 4, offset + 8);
      if (offset + 12 + length > data.length) break;
      if (crc32(data.subarray(offset + 4, offset + 8 + length)) !== data.readUInt32BE(offset + 8 + length)) break;
      if (!ihdr) {
        if (type !== 'IHDR' || length !== 13 || !data.readUInt32BE(offset + 8) || !data.readUInt32BE(offset + 12)) break;
        ihdr = true;
      }
      if (type === 'IDAT' && length > 0) idat = true;
      offset += length + 12;
      if (type === 'IEND') { ended = length === 0 && offset === data.length; break; }
    }
    if (ihdr && idat && ended) return { mime: 'image/png', extension: '.png' };
  }
  if (data.length >= 32 && ['GIF87a', 'GIF89a'].includes(data.toString('ascii', 0, 6)) && data.readUInt16LE(6) && data.readUInt16LE(8)) {
    let offset = 13 + ((data[10] & 0x80) ? 3 * (2 ** ((data[10] & 7) + 1)) : 0), frameCount = 0;
    const skipSubBlocks = (requireData = false) => {
      let hasData = false;
      while (offset < data.length) {
        const length = data[offset++];
        if (!length) return !requireData || hasData;
        hasData = true;
        offset += length;
      }
      return false;
    };
    while (offset < data.length) {
      const marker = data[offset++];
      if (marker === 0x3b) { if (frameCount === 1 && offset === data.length) return { mime: 'image/gif', extension: '.gif' }; break; }
      if (marker === 0x21) { offset++; if (!skipSubBlocks()) break; }
      else if (marker === 0x2c) {
        if (offset + 9 >= data.length || !data.readUInt16LE(offset + 4) || !data.readUInt16LE(offset + 6)) break;
        const packed = data[offset + 8]; offset += 9;
        if (packed & 0x80) offset += 3 * (2 ** ((packed & 7) + 1));
        const minCodeSize = data[offset++];
        if (minCodeSize < 2 || minCodeSize > 8 || !skipSubBlocks(true)) break;
        frameCount++;
        if (frameCount > 1) fail('插画投稿只支持静态 GIF，不支持包含多帧的动态 GIF。', 415);
      } else break;
    }
  }
  if (data.length >= 20 && data[0] === 255 && data[1] === 216 && data.at(-2) === 255 && data.at(-1) === 217) {
    let offset = 2, dimensions = false;
    while (offset + 4 < data.length) {
      if (data[offset] !== 255) break;
      while (data[offset] === 255) offset++;
      const marker = data[offset++];
      if (marker === 0xda) { if (dimensions && data.readUInt16BE(offset) >= 6 && offset + data.readUInt16BE(offset) < data.length - 2) return { mime: 'image/jpeg', extension: '.jpg' }; break; }
      if (marker === 0xd9) break;
      const length = data.readUInt16BE(offset);
      if (length < 2 || offset + length > data.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 8) dimensions = data.readUInt16BE(offset + 3) > 0 && data.readUInt16BE(offset + 5) > 0;
      offset += length;
    }
  }
  fail('文件不是有效的 PNG、JPEG 或 GIF 图片。', 415);
}

function sanitizeContent(input, base = {}) {
  object(input, '作品选项');
  const content = { type: 'illust', aiGenerated: true, rating: null, visibility: 'public', original: false,
    sexualContent: null, adultAttributes: [], allowTagEdit: true, allowComments: true, allowCollection: true, tools: [], seriesId: '', imageResponse: '',
    allowImageResponse: false, contestTag: '', poll: { question: '', answers: [] }, thumbnail: { page: 1, x: 0.5, y: 0.5 }, ...base };
  if (own(input, 'type')) content.type = enumValue(input.type, ['illust', 'manga'], '作品类型');
  if (own(input, 'aiGenerated')) content.aiGenerated = input.aiGenerated === null ? null : bool(input.aiGenerated, 'AI 生成标识');
  if (own(input, 'sexualContent')) content.sexualContent = input.sexualContent === null ? null : bool(input.sexualContent, '性描写标识');
  if (own(input, 'rating')) content.rating = enumValue(input.rating, [null, 'all', 'r18', 'r18g'], '作品分级');
  if (own(input, 'visibility')) content.visibility = enumValue(input.visibility, ['public', 'logged_in', 'mypixiv', 'private'], '公开范围');
  if (own(input, 'adultAttributes')) {
    if (!Array.isArray(input.adultAttributes) || input.adultAttributes.length > 4) fail('作品属性列表无效。');
    content.adultAttributes = [...new Set(input.adultAttributes.map(value => enumValue(value, ['underage', 'furry', 'bl', 'gl'], '作品属性')))];
  }
  if (content.rating === 'all') content.adultAttributes = [];
  for (const key of ['original', 'allowTagEdit', 'allowComments', 'allowCollection', 'allowImageResponse']) if (own(input, key)) content[key] = bool(input[key], key);
  for (const key of ['seriesId', 'imageResponse', 'contestTag']) if (own(input, key)) content[key] = string(input[key], key, 120);
  if (own(input, 'tools')) {
    if (!Array.isArray(input.tools) || input.tools.length > 20) fail('创作工具列表无效。');
    content.tools = input.tools.map(tool => string(tool, '创作工具', 100, false));
  }
  if (own(input, 'poll')) {
    object(input.poll, '问卷');
    if (!Array.isArray(input.poll.answers) || input.poll.answers.length > 10) fail('问卷选项无效。');
    content.poll = { question: string(input.poll.question ?? '', '问卷问题', 200), answers: input.poll.answers.map(answer => string(answer, '问卷选项', 200, false)) };
  }
  if (own(input, 'thumbnail')) {
    object(input.thumbnail, '缩略图');
    const { page: pageNumber, x, y } = input.thumbnail;
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > 200 || !Number.isFinite(x) || x < 0 || x > 1 || !Number.isFinite(y) || y < 0 || y > 1) fail('缩略图位置无效。');
    content.thumbnail = { page: pageNumber, x, y };
  }
  return content;
}

function sanitizeJob(input, old, state, uploads, now) {
  const job = old ? clone(old) : { id: randomUUID(), title: '', caption: '', tags: [], tagsConfirmed: false, files: [], status: 'draft', scheduledAt: '', timezone: 'Asia/Tokyo', createdAt: now, content: sanitizeContent({}), demo: state.settings.demo };
  if (own(input, 'accountId')) {
    job.accountId = string(input.accountId, '账号', 100, false);
    if (!state.accounts.some(account => account.id === job.accountId)) fail('请选择存在的账号。');
  }
  if (!job.accountId && job.status !== 'draft') fail('请选择投稿账号。');
  if (own(input, 'title')) job.title = string(input.title, '标题', 32);
  if (own(input, 'caption')) job.caption = string(input.caption, '说明', 3000);
  if (own(input, 'timezone')) job.timezone = timezone(input.timezone);
  job.timezone = 'Asia/Tokyo';
  if (!old && !own(input,'scheduledAt')) job.scheduledAt = nextPostingSchedule(state.accounts.find(a=>a.id===job.accountId), now);
  if (own(input, 'scheduledAt')) {
    job.scheduledAt = string(input.scheduledAt, '预约时间', 80);
    if (job.scheduledAt && (!/(?:Z|[+-]\d\d:\d\d)$/.test(job.scheduledAt) || !Number.isFinite(Date.parse(job.scheduledAt)))) fail('预约时间必须包含时区。');
  }
  if (own(input, 'tags')) {
    if (!Array.isArray(input.tags) || input.tags.length > 10) fail('最多可填写 10 个标签。');
    job.tags = [...new Set(input.tags.map(tag => string(tag, '标签', 64, false)))];
    if (JSON.stringify(job.tags) !== JSON.stringify(old?.tags)) job.tagsConfirmed = false;
  }
  if (own(input, 'tagsConfirmed')) job.tagsConfirmed = bool(input.tagsConfirmed, '标签确认');
  if (own(input, 'files')) {
    if (!Array.isArray(input.files) || input.files.length > 200) fail('每件作品最多 200 张图片。');
    job.files = input.files.map(item => {
      object(item, '图片');
      const id = string(item.id, '图片标识', 100, false);
      const uploaded = uploads[id];
      if (uploaded && uploaded.mode === state.settings.mode) { const { mode, diskName, ...file } = uploaded; return file; }
      const demoFile = state.settings.demo && state.jobs.flatMap(work => work.files).find(file => file.id === id && file.demo);
      if (demoFile) return clone(demoFile);
      fail('图片不存在，或不属于当前模式。请先上传图片。');
    });
    if (JSON.stringify(job.files.map(file => file.id)) !== JSON.stringify(old?.files.map(file => file.id))) job.tagsConfirmed = own(input, 'tagsConfirmed') ? input.tagsConfirmed : false;
  }
  if (own(input, 'content')) job.content = sanitizeContent(input.content, job.content);
  if (own(input, 'tagTemplate')) {
    if (input.tagTemplate === null) delete job.tagTemplate;
    else {
      const template = object(input.tagTemplate, '标签模板记录'), account = state.accounts.find(item => item.id === job.accountId);
      if (template.accountId !== job.accountId || String(template.pixivUserId || '') !== String(account?.pixivUserId || '')) fail('标签模板与投稿账号不一致，请重新选择角色。', 409);
      const labels = key => {
        if (!Array.isArray(template[key]) || template[key].length > 10) fail('标签模板记录格式无效。');
        return [...new Set(template[key].map(value => { const tag = string(value, '模板标签', 64, false);
          if (/[\u0000-\u001f\u007f]/.test(tag)) fail('模板标签不能包含控制字符。'); return tag; }))];
      };
      job.tagTemplate = { id: string(template.id, '标签模板标识', 200, false), accountId: job.accountId,
        pixivUserId: String(account?.pixivUserId || ''), englishName: string(template.englishName, '模板角色名', 32, false),
        gameTags: labels('gameTags'), characterTags: labels('characterTags'),
        ownedTags: labels('ownedTags').filter(tag => job.tags.includes(tag)), removedTags: labels('removedTags').filter(tag => !job.tags.includes(tag)) };
    }
  } else if (job.tagTemplate && (job.tagTemplate.accountId !== job.accountId
    || job.tagTemplate.pixivUserId !== String(state.accounts.find(account => account.id === job.accountId)?.pixivUserId || '')
    || (old && (job.title !== old.title || JSON.stringify(job.files.map(file => file.id)) !== JSON.stringify(old.files.map(file => file.id)))))) delete job.tagTemplate;
  if (own(input, 'status')) job.status = enumValue(input.status, ['draft', 'queued'], '作品状态');
  if (job.files.length > 200 || job.files.some(file => file.size > IMAGE_LIMIT)) fail('每件作品最多 200 张图片，每张图片不超过 32 MiB。');
  if (job.files.reduce((total, file) => total + file.size, 0) > WORK_LIMIT) fail('每件作品的图片总大小不得超过 200 MB。');
  if (old?.uploadOutcome === 'not_uploaded' && ['draft', 'queued'].includes(job.status)) {
    job.reservationAttempt = (old.reservationAttempt ?? 1) + 1;
    delete job.remoteId; delete job.idempotencyKey; delete job.uploadStartedAt; delete job.lastError; delete job.reviewReason; delete job.uploadOutcome;
  }
  job.updatedAt = now;
  if (job.status === 'queued') {
    if (!state.accounts.some(account => account.id === job.accountId)) fail('请选择投稿账号。');
    const validation = validateJob(job, { now, requireSchedule: true });
    if (!validation.valid) fail('作品信息尚未满足预约要求。', 422, validation.errors);
  }
  return job;
}

function tagRequestFingerprint(mode, job) {
  return createHash('sha256').update(JSON.stringify({ mode, accountId: job.accountId ?? null,
    title: job.title, caption: job.caption, tags: job.tags, tagsConfirmed: job.tagsConfirmed,
    scheduledAt: job.scheduledAt, timezone: job.timezone, content: job.content,
    files: job.files.map(file => ({ id: file.id, mime: file.mime, size: file.size })) })).digest('hex');
}

function connectorTagEvidence(candidate) {
  if (!candidate || candidate.verified !== true || candidate.existing !== true || typeof candidate.tag !== 'string') return [];
  const evidence = Array.isArray(candidate.evidence) ? candidate.evidence : [candidate.evidence];
  return evidence.filter(item => {
    if (!item || item.kind !== 'pixiv_tag_page' || item.tag !== candidate.tag || typeof item.url !== 'string' || !Number.isFinite(Date.parse(item.checkedAt))) return false;
    try {
      const url = new URL(item.url);
      const match = /^\/tags\/([^/]+)(?:\/artworks)?\/?$/.exec(url.pathname);
      return url.protocol === 'https:' && ['www.pixiv.net', 'pixiv.net'].includes(url.hostname) && !url.username && !url.password && match && decodeURIComponent(match[1]) === candidate.tag;
    } catch { return false; }
  }).map(item => ({ kind: 'pixiv_tag_page', tag: item.tag, url: item.url, checkedAt: item.checkedAt }));
}

export async function createServer(options = {}) {
  const launcherToken = options.launcherToken ?? process.env.PIXIV_LAUNCHER_TOKEN ?? '';
  let closing = false, activeRequests = 0;
  const dataDir = path.resolve(options.dataDir ?? path.join(ROOT, '.data'));
  const publicDir = path.resolve(options.publicDir ?? path.join(ROOT, 'public'));
  const nowProvider = options.now ?? (() => new Date());
  const stateFile = path.join(dataDir, 'state.json');
  const uploadDir = path.join(dataDir, 'uploads');
  await fs.mkdir(uploadDir, { recursive: true });
  const characterMemory = await createCharacterMemory({ dataDir });
  const tagPools = await createTagPools({ dataDir });
  const memoryAnalyses = new Map();
  const memoryAnalysisMaxAge = 30 * 60 * 1000;
  let envelope;
  try {
    envelope = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    if (envelope.version !== 1 || !envelope.states?.demo || !envelope.states?.live || !['demo', 'live'].includes(envelope.mode)) throw new Error('本地数据格式无效；为保护现有数据，已停止启动。');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    envelope = { version: 1, mode: 'demo', states: { demo: createDemoState(nowProvider()), live: blankState() }, uploads: {} };
  }
  envelope.uploads ??= {};
  for (const state of Object.values(envelope.states)) {
    state.queueAutomation = { intervalMs: QUEUE_CHECK_INTERVAL_MS,
      nextCheckAt: state.queueAutomation?.nextCheckAt && Number.isFinite(Date.parse(state.queueAutomation.nextCheckAt))
        ? state.queueAutomation.nextCheckAt : nextQueueCheck(new Date(nowProvider()).toISOString()) };
    state.publicationReviewAutomation = { ...state.publicationReviewAutomation, intervalMs: QUEUE_CHECK_INTERVAL_MS,
      nextCheckAt: Number.isFinite(Date.parse(state.publicationReviewAutomation?.nextCheckAt))
        ? state.publicationReviewAutomation.nextCheckAt : nextQueueCheck(new Date(nowProvider()).toISOString()) };
    if (state.queueRun?.running) state.queueRun = { ...state.queueRun, running: false,
      completedAt: new Date(nowProvider()).toISOString(), message: '上次预约执行因服务重启而中断；未确认的结果将在下次检查时核对。' };
  }
  for (const state of Object.values(envelope.states)) for (const account of state.accounts) account.defaultPostingTime = defaultPostingTime(account);
  for (const state of Object.values(envelope.states)) for (const job of state.jobs) {
    if (job.content && !own(job.content, 'allowCollection')) job.content.allowCollection = true;
    if (job.content && !own(job.content, 'sexualContent')) job.content.sexualContent = null;
    if (job.content && !own(job.content, 'adultAttributes')) job.content.adultAttributes = [];
  }
  let chain = Promise.resolve();
  let tagPoolContextVersion = 0;
  let pixivSyncPending = false;
  let dedicatedChangePending = false;
  let queueRunPending = null, queueRunProgress = null, queueRunMode = null;
  let queueStopRequested = false;
  const queueStoppedAccounts = new Set();
  const avatarCache = new Map();
  const thumbnailCache = new Map(), thumbnailPending = new Map(), thumbnailWaiters = [];
  let thumbnailActive = 0;
  async function thumbnailSlot(task) {
    if (thumbnailActive >= 4) await new Promise(resolve => thumbnailWaiters.push(resolve));
    else thumbnailActive++;
    try { return await task(); }
    finally { const next = thumbnailWaiters.shift(); if (next) next(); else thumbnailActive--; }
  }
  const active = () => envelope.states[envelope.mode];
  const currentTime = () => envelope.mode === 'demo' ? active().settings.demoNow : new Date(nowProvider()).toISOString();
  const connectorBase = options.connectorUrl ?? process.env.PIXIV_CONNECTOR_URL ?? '';
  const connectorToken = options.connectorToken ?? process.env.PIXIV_CONNECTOR_TOKEN ?? '';
  const browserConnector = options.browserConnector ?? await createBrowserConnector({ dataDir, now: nowProvider,
    dedicatedChrome: options.dedicatedChrome ?? createDedicatedChrome({ dataDir }) });
  const browserConfigured = () => envelope.states.live.accounts.some(account => account.browser?.targetId);
  const analyticsStore = options.analyticsStore ?? createAnalyticsStore({ dataDir, now: nowProvider });
  const analyticsCollector = createAnalyticsCollector({ store: analyticsStore, now: nowProvider,
    getContext: () => ({ mode: envelope.mode, accounts: active().accounts, contextVersion: tagPoolContextVersion }),
    fetchAnalytics: (account, input) => {
      if (!browserConnector.analytics) throw new Error('当前连接器尚不支持统计采集，请连接已登录的 Chrome。');
      return browserConnector.analytics(account, input);
    },
    getCharacters: () => characterMemory.list({ mode: 'live' }),
    getSeedWorks: async account => {
      const scope = { mode: 'live', accountId: account.id, pixivUserId: account.pixivUserId };
      const evidence = tagPools.evidence(scope, [], { jobs: envelope.states.live.jobs });
      const catalog = buildCharacterCatalog({ scope, evidence, characters: await characterMemory.list({ mode: 'live' }) });
      const identityByWork = new Map();
      for (const template of catalog.templates) for (const id of template.sourceArtworkIds || []) {
        const list = identityByWork.get(String(id)) || [];
        list.push({ englishName: template.englishName, gameTags: template.gameTags }); identityByWork.set(String(id), list);
      }
      return evidence.recentWorks.map(work => ({ ...work,
        ...(identityByWork.has(String(work.artworkId)) ? { characters: identityByWork.get(String(work.artworkId)) } : {}) }));
    },
    ...(options.analyticsBatchDelayMs !== undefined ? { batchDelayMs: options.analyticsBatchDelayMs } : {}),
  });
  function analyticsScope(accountId = 'all') {
    if (accountId !== 'all' && !active().accounts.some(account => account.id === accountId)) fail('统计账号不存在。', 404);
    const accounts = envelope.mode === 'live' ? active().accounts : [];
    return { accounts, accountIds: accounts.map(analyticsAccountKey),
      accountId: accountId === 'all' ? 'all' : accounts.some(account => account.id === accountId) ? analyticsAccountKey(accounts.find(account => account.id === accountId)) : 'demo:no-data' };
  }
  function analyticsStatus() {
    const scope = analyticsScope();
    const stored = analyticsStore.status({ accountIds: scope.accountIds });
    return { ...stored, ...(envelope.mode === 'live' ? analyticsCollector.status() : {
      running: false, nextRegularAt: null, errors: [], message: '演示模式不读取真实账号统计；请切换到正式模式。',
    }), mode: envelope.mode };
  }
  let connectorUrl;
  if (connectorBase) {
    connectorUrl = new URL(connectorBase);
    if (!['http:', 'https:'].includes(connectorUrl.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(connectorUrl.hostname) || connectorUrl.username || connectorUrl.password || connectorUrl.search || connectorUrl.hash) throw new Error('PIXIV_CONNECTOR_URL 必须指向本机回环地址，且不能含账号或查询参数。');
  }
  const tagger = options.tagger ?? createTagger({ projectRoot: ROOT, dataDir, uploadDir,
    configPath: path.join(dataDir, 'tagger-config.json'),
    ...(options.taggerPythonPath ? { pythonPath: options.taggerPythonPath } : {}) });
  let taggerHealth = { available: false, ready: false, configured: false, status: 'checking', model: null,
    catalogEntries: 0, message: '正在检测本地识图模型，投稿管理已经可以使用。', checkedAt: null };
  let taggerCheck = null;
  async function refreshTaggerStatus(refresh = false) {
    if (taggerCheck) return taggerCheck;
    taggerCheck = (async () => {
    try {
      const health = await tagger.status({ refresh });
      taggerHealth = { available: health.ready === true, ready: health.ready === true, configured: health.configured === true,
        status: health.ready === true ? 'ready' : health.configured === true ? 'not_ready' : 'not_configured',
        model: health.model ?? null, modelVersion: health.modelVersion ?? null,
        catalogEntries: Number.isInteger(health.catalogEntries) ? health.catalogEntries : 0,
        catalogVersion: health.catalogVersion ?? null, modelFiles: health.modelFiles ?? [],
        message: health.message || health.error || (health.ready === true ? '本地识图模型已就绪。' : '请先完成本地识图模型设置。'),
        ...(health.code ? { code: health.code } : {}),
        ...(health.error ? { error: String(health.error) } : {}), checkedAt: new Date(nowProvider()).toISOString() };
    } catch (error) {
      taggerHealth = { available: false, ready: false, configured: false, status: 'error', model: null, catalogEntries: 0,
        error: error.message || '本地识图服务无法检测。', message: error.message || '本地识图服务无法检测。', checkedAt: new Date(nowProvider()).toISOString() };
    }
    return clone(taggerHealth);
    })();
    try { return await taggerCheck; } finally { taggerCheck = null; }
  }
  let persistChain = Promise.resolve();
  function persist(snapshot = envelope) {
    // Capture at the state transaction boundary; queued writes must never
    // serialize a later, concurrently mutated envelope or overtake each other.
    const captured = JSON.stringify(snapshot, null, 2);
    const result = persistChain.then(async () => {
    const temp = `${stateFile}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, captured, { mode: 0o600 });
      await fs.rename(temp, stateFile);
    } catch (error) {
      await fs.unlink(temp).catch(() => {});
      throw error;
    }
    });
    persistChain = result.catch(() => {});
    return result;
  }
  await persist();
  const publicState = () => {
    const state = clone(active());
    if (queueRunProgress && queueRunMode === envelope.mode) state.queueRun = clone(queueRunProgress);
    for (const account of state.accounts) {
      if (normalizeAvatarUrl(account.avatarUrl)) account.avatarUrl = `/api/accounts/${encodeURIComponent(account.id)}/avatar?v=${createHash('sha256').update(account.pixivUserId + account.avatarUrl).digest('hex').slice(0, 12)}`;
      else delete account.avatarUrl;
    }
    for (const job of state.jobs) {
      job.deleteBlockedReason = localJobDeletionReason(job, state);
      job.canDeleteLocally = !job.deleteBlockedReason;
    }
    return { ...state, mode: envelope.mode, now: currentTime(), connectorConfigured: Boolean(connectorUrl) || browserConfigured(),
      browser: { available: true, externalConnector: Boolean(connectorUrl) }, tagger: clone(taggerHealth) };
  };
  function serialize(operation) {
    const result = chain.then(operation);
    chain = result.catch(() => {});
    return result;
  }
  const tagPoolScope = account => ({ mode: envelope.mode, accountId: account.id, pixivUserId: String(account.pixivUserId || '') });
  function captureTagPool(accountId, expectedMode) {
    if (expectedMode !== undefined && expectedMode !== envelope.mode) fail('工作空间已经切换，请重新打开常用标签池。', 409);
    const account = active().accounts.find(item => item.id === accountId);
    if (!account) fail('请选择存在的投稿账号。', 404);
    return { scope: tagPoolScope(account), account: clone(account), contextVersion: tagPoolContextVersion };
  }
  function isCurrentTagPool(snapshot) {
    const account = active().accounts.find(item => item.id === snapshot.scope.accountId);
    return envelope.mode === snapshot.scope.mode && tagPoolContextVersion === snapshot.contextVersion
      && account && String(account.pixivUserId || '') === snapshot.scope.pixivUserId;
  }
  async function saveTagPool(snapshot, searched) {
    if (!isCurrentTagPool(snapshot)) fail('账号或工作空间已经变更，请重新同步常用标签池。', 409);
    return tagPools.sync(snapshot.scope, searched, { jobs: active().jobs });
  }
  async function postingCatalog(snapshot) {
    const { scope } = snapshot;
    const evidence = tagPools.evidence(scope, [], { jobs: envelope.states[scope.mode].jobs });
    const characters = await characterMemory.list({ mode: scope.mode });
    // Pixiv character-tag spellings are global vocabulary. Share only actual
    // verified labels between this user's bound accounts, never their format,
    // game-tag preferences, draft tags, or manually pinned common-pool text.
    const sharedVerifiedTags = [];
    for (const account of envelope.states[scope.mode].accounts) {
      if (!account.pixivUserId || account.id === scope.accountId) continue;
      const other = tagPools.evidence({ ...scope, accountId: account.id, pixivUserId: String(account.pixivUserId) }, [],
        { jobs: envelope.states[scope.mode].jobs });
      if (Number.isFinite(Date.parse(other.checkedAt))) sharedVerifiedTags.push(...other.frequentTags);
      sharedVerifiedTags.push(...other.recentWorks.flatMap(work => work.tags));
    }
    return { ...buildCharacterCatalog({ scope, evidence, characters, sharedVerifiedTags }), ...scope, checkedAt: evidence.checkedAt };
  }
  function matchingTemplates(catalog, name) {
    const key = normalizePoolTag(String(name || ''));
    return catalog.templates.filter(template => [template.englishName, ...(template.aliases || []), ...template.characterTags]
      .some(alias => normalizePoolTag(alias) === key));
  }
  function templateTagRole(template, tag) {
    if (template.tagRoles?.[tag]) return template.tagRoles[tag];
    if (/^R-18G?$/i.test(tag)) return 'rating';
    if (template.gameTags.includes(tag)) return 'game';
    if (template.characterTags.includes(tag)) return 'character';
    return 'scene';
  }
  function composedTemplateResult(template, options) {
    const composed = composePostingTemplate(template, options);
    const historical = template.source === 'pixiv-history';
    const source = historical ? 'pixiv-history-template' : 'account-style-template';
    const variant = template.variants?.find(item => item.id === composed.variantId);
    const activeTemplate = { ...template, gameTags: composed.gameTags, characterTags: composed.characterTags,
      orderedTags: variant?.orderedTags || template.orderedTags, activeVariantId: composed.variantId };
    return { status: 'resolved', source, identitySource: historical ? 'pixiv-history' : template.identitySource,
      identity: { id: template.id, englishName: template.englishName },
      gameTags: composed.gameTags, characterTags: composed.characterTags,
      tags: composed.tags, orderedTags: composed.tags, optionalTags: composed.optionalTags || [], template: activeTemplate,
      evidence: [{ kind: source, cached: true, checkedAt: template.evidenceCheckedAt,
        sourceArtworkIds: composed.sourceArtworkIds, formatSourceArtworkIds: template.formatSourceArtworkIds || [],
        identitySource: template.identitySource || 'pixiv-history', accountId: template.accountId, pixivUserId: template.pixivUserId }],
      message: historical ? '已沿用此账号已投稿作品的标签写法和顺序，画面标签按当前图片补充。'
        : '已填写角色标签，并沿用当前账号的游戏标签与投稿格式；此角色暂无独立历史模板。' };
  }
  function captureAvatar(account, snapshot) {
    const avatarUrl = normalizeAvatarUrl(snapshot?.avatarUrl);
    if (avatarUrl && snapshot.ok === true && String(snapshot.pixivUserId) === String(account.pixivUserId)) {
      account.avatarUrl = avatarUrl;
      account.avatarCheckedAt = currentTime();
    }
  }
  function postingIdentityLost(error) {
    return ['identity_mismatch', 'login_required', 'unbound', 'tab_gone'].includes(error?.code)
      || /账号.*(?:改变|退出|不符|不匹配)|登录.*(?:失效|退出)/.test(String(error?.message || ''));
  }
  async function browserSnapshot(account) {
    const snapshot = await browserConnector.snapshot(account, { jobs: envelope.states.live.jobs });
    captureAvatar(account, snapshot);
    return snapshot;
  }
  function requireDedicatedChange(account) {
    if (envelope.mode !== 'live') fail('请先切换到真实工作空间。', 409);
    if (connectorUrl) fail('当前使用外部连接器，请先移除 PIXIV_CONNECTOR_URL 配置。', 409);
    if (queueRunPending || pixivSyncPending || analyticsCollector.status().running) fail('正在采集数据或处理预约，请等待当前任务完成后切换浏览器。', 409);
    if (account && !/^\d+$/.test(String(account.pixivUserId || ''))) fail('请先填写此账号的 Pixiv 用户 ID，以便核对登录身份。', 409);
  }
  function pendingDedicated(account) {
    const previous = account.browser || {};
    account.browser = { mode: 'dedicated', targetId: null, postingEnabled: false, loginPending: true,
      resumePostingEnabled: previous.resumePostingEnabled ?? previous.postingEnabled === true,
      ...(['interactive', 'headless'].includes(previous.runtimeMode) ? { runtimeMode: previous.runtimeMode } : {}) };
    account.connected = false;
    account.remote = { ...account.remote, syncOk: false, error: '请打开专用 Chrome，登录此账号后确认。' };
    tagPoolContextVersion++;
  }
  function acceptDedicated(account, result, now) {
    if (String(result?.account?.pixivUserId) !== String(account.pixivUserId)
      || String(result?.snapshot?.pixivUserId) !== String(account.pixivUserId)) fail('专用 Chrome 登录的 Pixiv 账号与此账号不一致，请切换到正确的账号。', 409);
    if (!result.snapshot.connected || !isCompleteRemoteSnapshot(result.snapshot, account)
      || result.account.browser?.mode !== 'dedicated' || !result.account.browser?.targetId) fail('尚未完整确认专用 Chrome 的登录状态，请登录后重试。', 409);
    const resumePosting = account.browser.resumePostingEnabled === true;
    account.browser = { mode: 'dedicated', targetId: result.account.browser.targetId, loginPending: false,
      postingEnabled: resumePosting && result.snapshot.premium === true,
      runtimeMode: result.account.browser.runtimeMode === 'interactive' ? 'interactive' : 'headless' };
    account.connected = true; account.premium = result.snapshot.premium === true;
    captureAvatar(account, result.snapshot);
    tagPoolContextVersion++;
    const state = reconcileRemote(active(), account.id, result.snapshot, now); replaceState(state);
    return state;
  }
  async function connector(endpoint, method = 'GET', payload, { manualPosting = false, shouldStop } = {}) {
    if (!connectorUrl) {
      const match = /^\/accounts\/([^/]+)\/(snapshot|reservations)$/.exec(endpoint);
      if (match) {
        const account = envelope.states.live.accounts.find(item => item.id === decodeURIComponent(match[1]));
        if (!account?.browser?.targetId) fail('此账号尚未连接 Chrome，请在账号管理中绑定已登录的 Pixiv 标签页。', 503);
        if (match[2] === 'snapshot' && method === 'GET') return browserSnapshot(account);
        if (match[2] === 'reservations' && method === 'POST') {
          const files = payload.job.files.map(file => {
            const stored = envelope.uploads[file.id];
            if (!stored || stored.mode !== 'live') fail('投稿图片不属于真实工作空间。');
            return path.join(uploadDir, stored.diskName);
          });
          const postingAccount = manualPosting ? { ...account, browser: { ...account.browser, postingEnabled: true } } : account;
          return browserConnector.reserve(postingAccount, payload.job, files, payload.idempotencyKey, { shouldStop });
        }
      }
    }
    if (!connectorUrl) fail('真实 pixiv 连接器尚未配置。作品已保存在本机；当前不会向 pixiv 投稿。', 503);
    if (method === 'POST' && /\/reservations$/.test(endpoint) && typeof shouldStop === 'function' && shouldStop()) {
      return { definitive: true, outcome: 'not_uploaded', paused: true, error: '预约已暂停，尚未提交。' };
    }
    let response;
    try {
      response = await fetch(new URL(`${connectorUrl.pathname.replace(/\/$/, '')}${endpoint}`, connectorUrl), {
        method, redirect: 'error', signal: AbortSignal.timeout(20000),
        headers: { Accept: 'application/json', ...(payload ? { 'Content-Type': 'application/json' } : {}), ...(connectorToken ? { Authorization: `Bearer ${connectorToken}` } : {}) },
        body: payload ? JSON.stringify(payload) : undefined,
      });
    } catch { fail('本机 pixiv 连接器无法访问或响应超时。', 503); }
    if (!response.ok) fail(`本机 pixiv 连接器返回错误（${response.status}）。`, 503);
    const text = await response.text();
    if (text.length > 2 * JSON_LIMIT) fail('连接器返回的数据过大。', 502);
    try { return object(JSON.parse(text), '连接器响应'); } catch { fail('连接器响应格式无效。', 502); }
  }
  function captureTagRequest(input) {
    const state = active(), mode = envelope.mode;
    const provider = enumValue(input.provider ?? (mode === 'demo' ? 'demo' : 'local'), ['demo', 'local', 'connector'], '标签建议来源');
    if (provider === 'demo' && mode !== 'demo') fail('演示标签只可在演示模式中使用。', 409);
    if (provider === 'connector' && mode !== 'live') fail('请切换真实模式后明确选择连接器标签建议。', 409);
    if (own(input, 'draft') && own(input, 'jobId')) fail('请提供作品草稿或作品 ID，不能同时提供。');
    const job = own(input, 'draft')
      ? sanitizeJob({ ...object(input.draft, '作品草稿'), status: 'draft' }, null, state, envelope.uploads, currentTime())
      : clone(state.jobs.find(item => item.id === input.jobId));
    if (!job) fail('请提供作品草稿或已保存的作品 ID。', 404);
    if (!job.files.length) fail('请先上传作品图片。');
    const files = provider === 'demo' ? [] : job.files.map(file => {
      if (file.demo || file.mime === 'image/svg+xml') fail('演示封面不能用于真实识图，请上传图片。', 422);
      const uploaded = envelope.uploads[file.id];
      if (!uploaded || uploaded.mode !== mode) fail('图片不存在或不属于当前模式，请重新上传。', 404);
      const diskPath = path.resolve(uploadDir, uploaded.diskName);
      if (!diskPath.startsWith(`${uploadDir}${path.sep}`)) fail('图片路径无效。');
      return { id: uploaded.id, name: uploaded.name, mime: uploaded.mime, size: uploaded.size, path: diskPath };
    });
    const poolSnapshot = job.accountId ? captureTagPool(job.accountId, mode) : null;
    return { mode, provider, job, files, account: clone(state.accounts.find(a=>a.id===job.accountId)), poolSnapshot, jobId: own(input, 'draft') ? null : job.id,
      requestFingerprint: tagRequestFingerprint(mode, job) };
  }
  function cacheMemoryAnalysis(snapshot, result) {
    for (const [key, value] of memoryAnalyses) if (Date.now() - value.at > memoryAnalysisMaxAge) memoryAnalyses.delete(key);
    if (snapshot.files.length !== 1 || result.analyzedFiles?.length !== 1 || !result.recognition || result.recognition.perFile?.[0]?.multiple) return;
    const file = result.analyzedFiles[0];
    if (file.id !== snapshot.files[0].id || !/^[a-f0-9]{64}$/i.test(file.sha256 || '')) return;
    while (memoryAnalyses.size >= 128) memoryAnalyses.delete(memoryAnalyses.keys().next().value);
    const id = randomUUID();
    memoryAnalyses.set(id, { at: Date.now(), mode: snapshot.mode, accountId: snapshot.job.accountId, file: clone(file),
      pixivUserId: snapshot.poolSnapshot?.scope.pixivUserId, contextVersion: snapshot.poolSnapshot?.contextVersion,
      predictions: clone(result.predictions || []), recognition: clone(result.recognition) });
    return id;
  }
  async function rememberCharacter(input) {
    if (input.mode !== envelope.mode) fail('工作空间已经切换，请重新打开角色记忆。', 409);
    const snapshot = captureTagRequest({ draft: input.draft, provider: 'local' });
    const saved = memoryAnalyses.get(string(input.analysisId, '识图记录', 100, false));
    if (!saved || Date.now() - saved.at > memoryAnalysisMaxAge || saved.mode !== snapshot.mode || saved.accountId !== snapshot.job.accountId
        || saved.pixivUserId !== snapshot.poolSnapshot?.scope.pixivUserId || saved.contextVersion !== snapshot.poolSnapshot?.contextVersion
        || snapshot.files.length !== 1 || saved.file.id !== snapshot.files[0].id) fail('图片或账号已变更，或识图记录已过期。请先重新识图。', 409);
    if (input.confirmedSingleCharacter !== true) fail('请先确认图片中只有这一个角色。');
    const bytes = await fs.readFile(snapshot.files[0].path);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== saved.file.sha256) fail('图片已变更，请重新上传并识图。', 409);
    const character = await characterMemory.remember({ mode: snapshot.mode, englishName: input.englishName,
      gameTags: input.gameTags, characterTags: input.characterTags, characterId: input.characterId,
      fileId: saved.file.id, sha256, descriptor: saved.file.descriptor, confirmedSingleCharacter: true });
    return { mode: snapshot.mode, character, characters: await characterMemory.list({ mode: snapshot.mode }) };
  }
  async function resolveCharacterTags(input) {
    const name = string(input.name, '角色名称', 64, false);
    if (/[\u0000-\u001f\u007f,，、;；&+\/\\|｜]/u.test(input.name) || /\b(?:and|with|vs\.?|versus)\b/iu.test(name)) fail('请一次填写一个角色名称，不要填写多个角色或分隔符。');
    const snapshot = await serialize(() => captureTagPool(input.accountId, enumValue(input.mode, ['demo', 'live'], '运行模式')));
    const characters = await characterMemory.list({ mode: snapshot.scope.mode });
    if (!isCurrentTagPool(snapshot)) fail('账号或工作空间已经变更，请重新填写角色名称。', 409);
    const catalog = await postingCatalog(snapshot);
    if (!isCurrentTagPool(snapshot)) fail('账号或工作空间已经变更，请重新选择角色。', 409);
    let selected;
    if (own(input, 'templateId')) {
      const id = string(input.templateId, '历史模板', 200, false);
      selected = catalog.templates.find(template => template.id === id);
      if (!selected) fail('该角色模板不属于当前账号或已更新，请重新选择。', 409);
      if (!matchingTemplates({ templates: [selected] }, name).length) fail('角色名称与所选模板不一致，请重新选择。', 409);
    } else {
      const matches = matchingTemplates(catalog, name);
      if (matches.length > 1) return { ...snapshot.scope, name, status: 'ambiguous', candidates: matches,
        gameTags: [], characterTags: [], tags: [], message: '此名称对应多个历史角色，请从角色列表中选择。' };
      selected = matches[0];
    }
    if (selected) {
      const rating = input.rating == null ? null : enumValue(input.rating, ['all', 'r18', 'r18g'], '年龄限制');
      if (input.sceneTags !== undefined && (!Array.isArray(input.sceneTags) || input.sceneTags.length > 100)) fail('画面标签格式无效。');
      const sceneTags = (input.sceneTags || []).map(tag => string(tag, '画面标签', 64, false));
      let predictions = [];
      if (input.analysisId) {
        const analysis = memoryAnalyses.get(string(input.analysisId, '识图记录', 100, false));
        if (!analysis || Date.now() - analysis.at > memoryAnalysisMaxAge || analysis.mode !== snapshot.scope.mode
          || analysis.accountId !== snapshot.scope.accountId || analysis.pixivUserId !== snapshot.scope.pixivUserId
          || analysis.contextVersion !== snapshot.contextVersion) fail('识图记录已过期或账号已变更，请重新分析图片。', 409);
        predictions = analysis.predictions || [];
      }
      return { ...composedTemplateResult(selected, { rating, sceneTags, predictions }), ...snapshot.scope, name };
    }
    const pool = tagPools.get(snapshot.scope, { jobs: envelope.states[snapshot.scope.mode].jobs });
    const evidence = { ...tagPools.evidence(snapshot.scope, [], { jobs: envelope.states[snapshot.scope.mode].jobs }), excludedTags: pool.hiddenTags };
    const plan = planManualCharacterTags({ name, characters, evidence });
    const cached = { ...tagPools.evidence(snapshot.scope, plan.queries || [], { jobs: envelope.states[snapshot.scope.mode].jobs }), excludedTags: pool.hiddenTags };
    let result = resolveManualCharacterTags(plan, cached);
    // This endpoint resolves text supplied by the user. It never analyzes an
    // image, writes a work, or turns a title into a character-memory sample.
    if (result.status !== 'resolved' && result.status !== 'ambiguous' && plan.queries?.length
      && snapshot.scope.mode === 'live' && snapshot.account.browser?.targetId && browserConnector.searchTags) {
      try {
        const searched = await browserConnector.searchTags(snapshot.account, plan.queries.map(query => query.word), { includeHistory: false });
        const freshPool = await serialize(() => {
          if (!isCurrentTagPool(snapshot)) fail('账号或工作空间已经变更，请重新填写角色名称。', 409);
          if (String(searched.pixivUserId || '') !== snapshot.scope.pixivUserId) fail('Pixiv 登录账号与绑定资料不一致，未采用角色标签。', 409);
          return tagPools.get(snapshot.scope, { jobs: active().jobs });
        });
        result = resolveManualCharacterTags(plan, { ...searched, source: 'pixiv', cached: false, preferredTags: freshPool.tags, excludedTags: freshPool.hiddenTags });
      } catch (error) {
        if (!isCurrentTagPool(snapshot)) fail('账号或工作空间已经变更，请重新填写角色名称。', 409);
        if (error.status === 409) throw error;
        result = { ...result, message: `${result.message || '尚未核实对应的角色与作品标签。'} Pixiv 标签核对暂未完成：${error.message}` };
      }
    }
    return serialize(() => {
      if (!isCurrentTagPool(snapshot)) fail('账号或工作空间已经变更，请重新填写角色名称。', 409);
      return { ...result, ...snapshot.scope, name };
    });
  }
  async function suggestTags(snapshot) {
    const { mode, provider, job, files } = snapshot;
    let result;
    if (provider === 'demo') {
      result = { source: 'demo', demo: true, message: '以下是固定演示建议，未进行图片识别或实时 pixiv 标签检索。请自行确认。', candidates: [
        { tag: 'オリジナル', confidence: 0.96, reason: '演示：原创作品标签', existing: false },
        { tag: '風景', confidence: 0.91, reason: '演示：场景元素标签', existing: false },
        { tag: 'イラスト', confidence: 0.87, reason: '演示：插画类型标签', existing: false },
        { tag: '空', confidence: 0.82, reason: '演示：天空元素标签', existing: false },
        { tag: '女の子', confidence: 0.74, reason: '演示：人物标签，需用户确认适用性', existing: false },
      ] };
    } else if (provider === 'local') {
      const health = await refreshTaggerStatus();
      if (!health.available) fail(health.error || '本地识图模型尚未就绪，请先完成本地模型设置。', 503, { tagger: health });
      try {
        result = await tagger.analyze(files);
      } catch (error) {
        await refreshTaggerStatus();
        fail(error.message || '本地图片识别失败。', Number.isInteger(error.status) ? error.status : 503);
      }
      if (!result || !Array.isArray(result.candidates) || result.source !== 'local') fail('本地识图服务返回格式无效。', 502);
      result = await applyCharacterMemory(result, characterMemory, mode);
      const memoryAnalysisId = cacheMemoryAnalysis(snapshot, result);
      // The immutable descriptor stays on the server. Clients may confirm a
      // label against this analysis, but cannot submit their own image vector.
      result = { ...result, ...(memoryAnalysisId ? { memoryAnalysisId } : {}),
        analyzedFiles: (result.analyzedFiles || []).map(({ descriptor, ...file }) => file) };
      result = {...result, candidates:annotateTagCandidates(result.candidates, result.predictions, result.recognition)};
      let tagPool = snapshot.poolSnapshot ? tagPools.get(snapshot.poolSnapshot.scope, { jobs: envelope.states[mode].jobs }) : null;
      const priorEvidence = snapshot.poolSnapshot ? tagPools.evidence(snapshot.poolSnapshot.scope, [], { jobs: envelope.states[mode].jobs }) : {};
      const queries = tagQueries(result.predictions || [], result.candidates, result.recognition, { ...priorEvidence, preferredTags: tagPool?.tags || [], excludedTags: tagPool?.hiddenTags || [] });
      const applySearch = searched => {
        const candidates = rankPixivTags(queries, { ...searched, preferredTags: tagPool?.tags || [], excludedTags: tagPool?.hiddenTags || [] });
        const matchedConcepts = new Set(candidates.flatMap(candidate => candidate.modelNames || []));
        result = { ...result, candidates, unmapped: (result.unmapped || []).filter(item => !matchedConcepts.has(item.name)),
          tagSearch: { source: searched.source || 'pixiv', cached: searched.cached === true, scope: searched.cached ? 'account-cache' : 'site-wide',
            frequentTags: searched.frequentTags, recentWorks: searched.recentWorks || [], pixivUserId: searched.pixivUserId, checkedAt: searched.checkedAt } };
      };
      const applyCachedPool = () => {
        if (!snapshot.poolSnapshot) return false;
        tagPool = tagPools.get(snapshot.poolSnapshot.scope, { jobs: envelope.states[mode].jobs });
        const cached = tagPools.evidence(snapshot.poolSnapshot.scope, queries, { jobs: envelope.states[mode].jobs });
        if (!cached.checkedAt && !cached.recentWorks?.length) return false;
        applySearch(cached.checkedAt ? cached : { ...cached, source: 'local-history' });
        return true;
      };
      // Established account history is sufficient for normal uploads. Global
      // search remains available explicitly, without reconnecting Chrome per image.
      if (mode === 'live' && priorEvidence.recentWorks?.length && applyCachedPool()) {
        result = { ...result, warnings: [...(result.warnings || []).filter(w => !w.includes('有来源证据'))] };
      } else if (mode === 'live' && snapshot.account?.browser?.targetId && browserConnector.searchTags) {
        try {
          const searched = await browserConnector.searchTags(snapshot.account, queries.map(q=>q.word), {includeHistory:true});
          // Store only for the same still-selected account. The browser call is
          // outside the mutation queue, so mode/account edits remain responsive.
          tagPool = await serialize(() => saveTagPool(snapshot.poolSnapshot, { ...searched, recentWorks: searched.recentWorks || [] }));
          applySearch(searched);
          result = {...result, warnings:[...(result.warnings||[]).filter(w=>!w.includes('有来源证据')), ...(searched.historyWarning?[searched.historyWarning]:[])]};
        } catch (error) {
          const cached = applyCachedPool();
          result = {...result, warnings:[...(result.warnings||[]), `Pixiv 全站匹配未完成：${error.message} ${cached ? '当前使用此账号已核实的常用标签缓存，核实日期保留在候选中。' : '当前仅显示已有本地证据的候选。'}`]};
        }
      } else if (mode === 'live') {
        const cached = applyCachedPool();
        result = {...result,warnings:[...(result.warnings||[]),cached ? '当前使用此账号已核实的常用标签缓存；同步常用标签可更新。' : '请连接此账号的 Chrome，以启用 Pixiv 全站标签匹配和常用标签优先。']};
      }
      if (tagPool) {
        const preferred = new Set(tagPool.tags.map(normalizePoolTag));
        const established = Boolean(tagPool.tags.length || tagPool.hiddenTags.length || tagPool.checkedAt);
        result = { ...result, candidates: result.candidates.map(candidate => candidate.accountPreferenceContext !== undefined ? candidate : {
          ...candidate, accountPreferenceContext: established, preferred: preferred.has(normalizePoolTag(candidate.tag)),
        }) };
      }
      result = {...result, tagPool, automaticTags:selectAutomaticTags(result.candidates, result.recognition)};
      if (snapshot.poolSnapshot) {
        const catalog = await postingCatalog(snapshot.poolSnapshot);
        const recognition = result.recognition;
        const matches = files.length === 1 && recognition?.title && !recognition.perFile?.some(file => file.multiple)
          ? matchingTemplates(catalog, recognition.title) : [];
        if (matches.length === 1) {
          const template = matches[0], composed = composedTemplateResult(template, { rating: recognition.rating, predictions: result.predictions || [] });
          const automaticTags = composed.orderedTags.map(tag => ({ tag, tagRole: templateTagRole(template, tag), source: composed.source,
            existing: template.identitySource !== 'user-memory', verified: template.identitySource !== 'user-memory', preferred: true,
            reason: template.source === 'pixiv-history' ? '此账号已投稿作品的标签模板' : '角色标签配合当前账号的投稿格式', templateId: template.id }));
          result = { ...result, template: composed.template, orderedTags: composed.orderedTags, optionalTags: composed.optionalTags,
            automaticTags: composed.orderedTags, recognition: { ...recognition, title: template.englishName },
            candidates: [...automaticTags, ...result.candidates.filter(candidate => !composed.orderedTags.includes(candidate.tag))] };
        }
        result.templateHistoryCount = catalog.historyCount;
      }
      await refreshTaggerStatus();
    } else {
      if (!connectorUrl) fail('真实 pixiv 连接器尚未配置，无法使用连接器标签建议。', 503);
      const candidatesByTag = new Map(), hashes = [];
      // The explicit connector adapter is fed one image at a time to avoid
      // expanding a whole 200 MB work into a single giant base64 request.
      for (const file of files) {
        const bytes = await fs.readFile(file.path);
        hashes.push({ id: file.id, sha256: createHash('sha256').update(bytes).digest('hex') });
        const response = await connector('/tags/suggest', 'POST', { accountId: job.accountId,
          files: [{ id: file.id, name: file.name, mime: file.mime, size: file.size, base64: bytes.toString('base64') }],
          content: job.content, title: job.title, caption: job.caption });
        if (!Array.isArray(response.candidates)) fail('连接器未返回标签候选。', 502);
        for (const candidate of response.candidates) {
          const evidence = connectorTagEvidence(candidate);
          if (!evidence.length) continue;
          const tag = string(candidate.tag, '标签', 64, false);
          const previous = candidatesByTag.get(tag);
          const confidence = Number.isFinite(candidate.confidence) ? Math.max(0, Math.min(1, candidate.confidence)) : null;
          candidatesByTag.set(tag, { tag, confidence: previous ? Math.max(previous.confidence ?? 0, confidence ?? 0) : confidence,
            reason: typeof candidate.reason === 'string' ? candidate.reason.slice(0, 500) : '连接器提供了此 pixiv 标签页的核实记录。',
            existing: true, verified: true, evidence: [...(previous?.evidence ?? []), ...evidence],
            sourceUrl: evidence[0].url, fileIds: [...(previous?.fileIds ?? []), file.id] });
        }
      }
      const candidates = [...candidatesByTag.values()].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0)).slice(0, 20);
      if (!candidates.length) fail('连接器没有提供包含真实标签页来源的已核实标签；不会使用仅有布尔标记的候选。', 502);
      result = { source: 'pixiv', demo: false, candidates, analyzedFiles: hashes,
        inputFingerprint: createHash('sha256').update(JSON.stringify(hashes)).digest('hex') };
    }
    const latestJob = snapshot.jobId ? envelope.states[mode].jobs.find(item => item.id === snapshot.jobId) : null;
    const modeChanged = envelope.mode !== mode;
    const accountChanged = Boolean(snapshot.poolSnapshot && !isCurrentTagPool(snapshot.poolSnapshot));
    const sourceChanged = Boolean(snapshot.jobId && (!latestJob || tagRequestFingerprint(mode, latestJob) !== snapshot.requestFingerprint));
    return { ...result, ...(snapshot.poolSnapshot?.scope || {}), mode, provider, requestFingerprint: snapshot.requestFingerprint,
      modeChanged, accountChanged, sourceChanged, stale: modeChanged || accountChanged || sourceChanged };
  }
  function replaceState(next) { envelope.states[envelope.mode] = next; }
  function demoSnapshot(account) { return { ok: true, complete: true, total: account.remote.reservations.filter(item => ['reserved', 'scheduled', 'uploading'].includes(item.status)).length, reservations: clone(account.remote.reservations) }; }
  function recordPublicationReview(state, summary, before, source) {
    const completedAt = summary.completedAt || currentTime();
    const previous = new Map(before.map(job => [job.id, job.status]));
    state.publicationReviewAutomation = { ...state.publicationReviewAutomation,
      intervalMs: QUEUE_CHECK_INTERVAL_MS, nextCheckAt: nextQueueCheck(completedAt),
      lastAttemptAt: summary.startedAt || completedAt,
      ...(summary.succeeded > 0 ? { lastCheckedAt: completedAt } : {}),
      lastResult: { ...clone(summary), source, completedAt, checked: summary.succeeded > 0,
        message: summary.succeeded > 0 ? '已完成至少一个账号的状态核对。' : '本次未完成账号状态核对，请查看失败或跳过原因。',
        published: state.jobs.filter(job => job.status === 'published' && previous.get(job.id) !== 'published').length,
        remainingNeedsReview: state.jobs.filter(job => job.status === 'needs_review').length } };
  }
  async function syncPixivStatus({ source = 'manual', accountIds } = {}) {
    if (envelope.mode !== 'live') fail('演示模式不能同步真实 Pixiv，请先切换到真实工作空间。', 409);
    let state = active();
    const before = clone(state.jobs);
    let connectionFailure;
    const summary = { startedAt: currentTime(), completedAt: null, succeeded: 0, failed: 0, skipped: 0, accounts: [] };
    state.pixivSync = summary;
    await persist();
    // This operation only reads snapshots. It must not run tick(), whose second
    // stage can upload queued work, even when all posting switches are enabled.
    for (const accountId of state.accounts.map(account => account.id).filter(id => !accountIds || accountIds.includes(id))) {
      let account = state.accounts.find(item => item.id === accountId);
      const result = { accountId, name: account.name };
      if (!connectorUrl && !account.browser?.targetId) {
        summary.skipped++;
        summary.accounts.push({ ...result, status: 'skipped', message: '尚未连接 Chrome，请先在账号管理中绑定 Pixiv。' });
      } else {
        try {
          if (connectionFailure && account.browser?.mode !== 'dedicated') throw connectionFailure;
          const snapshot = await connector(`/accounts/${encodeURIComponent(accountId)}/snapshot`);
          const records = snapshot?.reservations;
          const validRecords = Array.isArray(records) && records.every(record => record && typeof record === 'object' && !Array.isArray(record)
            && typeof (record.remoteId || record.id) === 'string' && (record.remoteId || record.id).trim()
            && typeof record.status === 'string' && record.status.trim());
          if (snapshot?.ok !== true || snapshot.connected !== true || typeof snapshot.premium !== 'boolean' || snapshot.complete !== true
            || !Number.isSafeInteger(snapshot.total) || snapshot.total < 0 || !validRecords
            || snapshot.total !== records.filter(record => record.status === 'reserved').length) {
            fail(typeof snapshot?.error === 'string' ? snapshot.error : 'Pixiv 状态未完整回读，本次同步未成功，请稍后重试。', 502);
          }
          if (snapshot.pixivUserId && String(snapshot.pixivUserId) !== account.pixivUserId) fail('当前 Pixiv 账号与绑定 ID 不符，已停止同步。', 409);
          const syncedAt = currentTime();
          account.connected = true; account.premium = snapshot.premium;
          state = reconcileRemote(state, accountId, snapshot, syncedAt); replaceState(state);
          summary.succeeded++;
          summary.accounts.push({ ...result, status: 'success', message: `已同步，Pixiv 当前预约 ${snapshot.total} 件。`, syncedAt });
        } catch (error) {
          if (!connectorUrl && account.browser?.mode !== 'dedicated' && ['approval_required', 'disconnected', 'timeout'].includes(error.code)) connectionFailure = error;
          account = state.accounts.find(item => item.id === accountId);
          const message = String(error.message || 'Pixiv 同步失败，请稍后重试。').slice(0, 1000);
          account.connected = false;
          account.remote = { ...account.remote, syncOk: false, lastSyncAttemptAt: currentTime(), error: message };
          if (account.browser && postingIdentityLost(error)) account.browser.postingEnabled = false;
          summary.failed++;
          summary.accounts.push({ ...result, status: 'error', message });
          log(state, `${account.name}：${message}`, 'error', currentTime());
        }
      }
      state.pixivSync = summary;
      await persist();
    }
    summary.completedAt = currentTime();
    state.pixivSync = summary;
    state.queueReasons = planReservations(state, summary.completedAt).reasons;
    recordPublicationReview(state, summary, before, source);
    const reviewResult = state.publicationReviewAutomation.lastResult;
    log(state, `Pixiv 状态${summary.succeeded ? '同步完成' : '未完成核对'}：${summary.succeeded} 个账号成功，${summary.failed} 个失败，${summary.skipped} 个未连接；新增确认发布 ${reviewResult.published} 件，仍有 ${reviewResult.remainingNeedsReview} 件需核对。`, summary.failed || !summary.succeeded ? 'warning' : 'info', summary.completedAt);
    await persist();
    return publicState();
  }
  function startPublicationReview() {
    if (pixivSyncPending || queueRunPending || dedicatedChangePending || envelope.mode !== 'live') return;
    if (!publicationReviewAccountIds(active(), currentTime()).length) return;
    pixivSyncPending = true;
    serialize(async () => {
      if (envelope.mode !== 'live') return;
      const accountIds = publicationReviewAccountIds(active(), currentTime());
      if (!accountIds.length || Date.parse(currentTime()) < Date.parse(active().publicationReviewAutomation.nextCheckAt)) return;
      const before = clone(active().jobs), startedAt = currentTime();
      try { await syncPixivStatus({ source: 'automatic', accountIds }); }
      catch (error) {
        // Network/account failures are recorded inside syncPixivStatus. Even an
        // unexpected run failure must not turn the minute timer into a retry loop.
        const summary = { startedAt, completedAt: currentTime(), succeeded: 0, failed: 1, skipped: 0,
          accounts: [], error: String(error.message || '自动核对未完成。').slice(0, 1000) };
        recordPublicationReview(active(), summary, before, 'automatic');
        const { error: message, ...syncSummary } = summary;
        active().pixivSync = syncSummary;
        log(active(), `Pixiv 自动复核未正常完成：${message} 已延后六小时重试。`, 'warning', summary.completedAt);
        await persist();
      }
    }).catch(error => console.error('Publication review:', error.message)).finally(() => { pixivSyncPending = false; });
  }
  async function tick({ manualStart = false, errors = [] } = {}) {
    if (!active().settings.demo && !connectorUrl && !browserConfigured()) fail('真实 pixiv 连接器尚未配置。请在账号管理中连接 Chrome。', 503);
    // The outer run still owns serialize(). Workers use this independent short
    // transaction lock, never hold it across browser work, and always reload
    // active state. No worker can overwrite another worker's completed result.
    let stateChain = Promise.resolve(), fatalStop = false;
    const blockedAccounts = new Set(), snapshotChains = new Map();
    const transaction = operation => {
      const result = stateChain.then(() => operation(clone(active())));
      stateChain = result.catch(() => {});
      return result;
    };
    async function commit(state) {
      const nextEnvelope = { ...envelope, states: { ...envelope.states, [envelope.mode]: state } };
      try { await persist(nextEnvelope); }
      catch (error) { fatalStop = true; throw error; }
      replaceState(state);
    }
    const stopped = accountId => fatalStop || queueStopRequested || queueStoppedAccounts.has(accountId) || blockedAccounts.has(accountId);
    async function syncAccount(accountId) {
      // Reads and their application are ordered per account so an older
      // snapshot cannot arrive late and undo a newer confirmed reservation.
      const previous = snapshotChains.get(accountId) || Promise.resolve();
      const result = previous.then(async () => {
        const account = clone(active().accounts.find(item => item.id === accountId));
        if (!account) fail('投稿账号不存在。', 409);
        const snapshot = active().settings.demo ? demoSnapshot(account) : await connector('/accounts/' + encodeURIComponent(accountId) + '/snapshot');
        if (!isCompleteRemoteSnapshot(snapshot, account)) fail('Pixiv 预约快照不完整或账号不符，本轮不会继续提交该账号。', 502);
        await transaction(async state => {
          const latest = state.accounts.find(item => item.id === accountId);
          if (!latest || latest.pixivUserId !== account.pixivUserId) fail('投稿账号已改变。', 409);
          if (!state.settings.demo) {
            latest.connected = snapshot.connected === true; latest.premium = snapshot.premium === true;
            captureAvatar(latest, snapshot);
          }
          await commit(reconcileRemote(state, accountId, snapshot, currentTime()));
        });
        return snapshot;
      });
      snapshotChains.set(accountId, result.catch(() => {}));
      return result;
    }
    const reviewBefore = clone(active().jobs), reviewSummary = { startedAt: currentTime(), completedAt: null,
      succeeded: 0, failed: 0, skipped: 0, accounts: [] };
    for (const accountId of active().accounts.map(account => account.id)) {
      try {
        await syncAccount(accountId);
        reviewSummary.succeeded++;
        reviewSummary.accounts.push({ accountId, status: 'success' });
      }
      catch (error) {
        blockedAccounts.add(accountId);
        reviewSummary.failed++;
        reviewSummary.accounts.push({ accountId, status: 'error', message: String(error.message).slice(0, 1000) });
        await transaction(async state => {
          const account = state.accounts.find(item => item.id === accountId);
          account.remote.syncOk = false;
          if (!state.settings.demo) account.connected = false;
          if (!state.settings.demo && !connectorUrl && account.browser && postingIdentityLost(error)) account.browser.postingEnabled = false;
          log(state, account.name + '：' + error.message, 'error', currentTime());
          errors.push({ accountId, message: String(error.message).slice(0, 1000) });
          await commit(state);
        });
      }
    }
    if (!active().settings.demo) await transaction(async state => {
      reviewSummary.completedAt = currentTime();
      recordPublicationReview(state, reviewSummary, reviewBefore, manualStart ? 'manual_queue' : 'automatic_queue');
      await commit(state);
    });
    async function claim() {
      return transaction(async state => {
        if (fatalStop || queueStopRequested || state.settings.queuePaused) return null;
        const plan = planReservations(state, currentTime());
        state.queueReasons = plan.reasons;
        const candidates = plan.actions.filter(action => {
          const account = state.accounts.find(item => item.id === action.accountId);
          return !stopped(action.accountId) && (manualStart || state.settings.demo || connectorUrl || account?.browser?.postingEnabled === true);
        });
        const activeByAccount = new Map();
        for (const job of state.jobs) if (job.status === 'uploading') activeByAccount.set(job.accountId, (activeByAccount.get(job.accountId) || 0) + 1);
        // Stable sorting preserves each account's chronological plan while
        // letting another ready account use a window before one takes both.
        candidates.sort((a, b) => (activeByAccount.get(a.accountId) || 0) - (activeByAccount.get(b.accountId) || 0));
        const action = candidates[0];
        if (!action) return null;
        const job = state.jobs.find(item => item.id === action.jobId), account = state.accounts.find(item => item.id === action.accountId);
        job.status = 'uploading'; job.uploadStartedAt = currentTime(); job.idempotencyKey = action.idempotencyKey;
        // Durable slot claim comes before any form preparation or upload. The
        // next claim counts this uploading job even though Pixiv cannot see it.
        await commit(state);
        return { action, job: clone(job), account: clone(account) };
      });
    }
    async function processClaim({ action, job: submittedJob }) {
      const accountId = action.accountId;
      try {
        // The native browser consumes trusted file paths itself. Avoid making
        // two potentially 200 MB base64 payloads when no external adapter uses them.
        const files = connectorUrl ? await Promise.all(submittedJob.files.map(async file => ({ ...file,
          base64: (await fs.readFile(path.join(uploadDir, envelope.uploads[file.id].diskName))).toString('base64') }))) : submittedJob.files;
        const ready = await transaction(async state => {
          const job = state.jobs.find(item => item.id === action.jobId);
          if (!job || job.status !== 'uploading' || job.idempotencyKey !== action.idempotencyKey) return false;
          const submissionState = { ...state, jobs: state.jobs.map(item => item.id === job.id ? { ...item, status: 'queued' } : item) };
          if (stopped(accountId) || !planReservations(submissionState, currentTime()).actions.some(candidate => candidate.jobId === job.id && candidate.accountId === accountId)) {
            job.status = 'queued'; delete job.uploadStartedAt;
            if (Date.parse(job.scheduledAt) <= Date.parse(currentTime())) {
              job.status = 'needs_review'; job.reviewReason = 'schedule_expired'; job.lastError = '预约时间已过，尚未发送，请重新安排。';
            }
            await commit(state); return false;
          }
          return true;
        });
        if (!ready) return;
        let result, simulatedSnapshot;
        if (active().settings.demo) {
          simulatedSnapshot = await transaction(async state => {
            const account = state.accounts.find(item => item.id === accountId);
            account.remote.reservations.push({ remoteId: 'demo-' + randomUUID(), jobId: submittedJob.id, idempotencyKey: action.idempotencyKey,
              scheduledAt: submittedJob.scheduledAt, status: 'reserved' });
            const snapshot = demoSnapshot(account);
            await commit(reconcileRemote(state, accountId, snapshot, currentTime()));
            return snapshot;
          });
        } else {
          result = await connector('/accounts/' + encodeURIComponent(accountId) + '/reservations', 'POST',
            { job: { ...submittedJob, files }, idempotencyKey: action.idempotencyKey },
            { manualPosting: manualStart, shouldStop: () => stopped(accountId) });
          if (result.definitive === true && result.outcome === 'not_uploaded' && !result.reservation) {
            if (result.paused === true || result.capacityBlocked === true) blockedAccounts.add(accountId);
            await transaction(async state => {
              const job = state.jobs.find(item => item.id === action.jobId);
              if (result.paused === true || result.capacityBlocked === true) {
                job.status = 'queued'; job.reservationAttempt = (job.reservationAttempt || 1) + 1;
                delete job.idempotencyKey; delete job.uploadStartedAt;
                log(state, job.title + (result.capacityBlocked ? '：预约名额已满，保留待补位。' : '：已停止本轮提交，尚未预约。'), 'info', currentTime());
              } else {
                job.status = 'failed'; job.uploadOutcome = 'not_uploaded';
                job.lastError = typeof result.error === 'string' ? result.error.slice(0, 500) : '连接器明确确认作品尚未上传，可修改后重新加入队列。';
                log(state, job.title + '：' + job.lastError, 'error', currentTime());
              }
              await commit(state);
            });
            if (result.capacityBlocked) {
              try { await syncAccount(accountId); }
              catch (error) {
                await transaction(async state => {
                  const account = state.accounts.find(item => item.id === accountId);
                  if (account) account.remote.syncOk = false;
                  errors.push({ accountId, message: '预约名额已满；重新核对名额失败：' + String(error.message).slice(0, 500) });
                  await commit(state);
                });
              }
            }
            return;
          }
          if (!result.reservation?.remoteId || result.reservation.status !== 'reserved') fail('连接器未返回可确认的远端预约；需要人工核对。', 502);
        }
        const snapshot = simulatedSnapshot || await syncAccount(accountId);
        if (!snapshot.reservations.some(item => item.idempotencyKey === action.idempotencyKey && ['reserved', 'published'].includes(item.status))) fail('远端快照尚未确认本次预约，已暂停重试以避免重复投稿。', 502);
        await transaction(async state => {
          const job = state.jobs.find(item => item.id === action.jobId);
          if (!['reserved', 'published'].includes(job?.status)) fail(job?.lastError || '远端结果存在冲突，必须人工核对后再继续。', 502);
          log(state, (state.settings.demo ? '演示预约' : '远端预约已确认') + '：' + job.title, 'success', currentTime());
          await commit(state);
        });
      } catch (error) {
        // Set this before awaiting the state lock: another prepared window can
        // observe the unknown outcome and stop before its final submit click.
        blockedAccounts.add(accountId);
        await transaction(async state => {
          const job = state.jobs.find(item => item.id === action.jobId);
          if (job && !['reserved', 'published'].includes(job.status)) {
            job.status = 'needs_review'; job.lastError = String(error.message).slice(0, 1000);
            job.reviewReason ??= 'upload_outcome_unknown';
          }
          const account = state.accounts.find(item => item.id === accountId);
          if (account) { account.remote.syncOk = false; account.remote.error = '上传结果尚未确认；请重新同步远端状态后核对。'; }
          log(state, submittedJob.title + '：' + error.message, 'error', currentTime());
          errors.push({ accountId, jobId: submittedJob.id, message: String(error.message).slice(0, 1000) });
          await commit(state);
        });
      }
    }
    async function worker() {
      try {
        while (!fatalStop && !queueStopRequested) {
          const claimResult = await claim();
          if (!claimResult) return;
          await processClaim(claimResult);
        }
      } catch (error) {
        fatalStop = true;
        errors.push({ message: String(error.message || '无法保存预约状态，后续提交已停止。').slice(0, 1000) });
      }
    }
    // HTTP adapters have no isolated-page/commit-lock or cooperative stop
    // contract. Preserve their serial behavior; the native browser owns two.
    await Promise.all(Array.from({ length: connectorUrl ? 1 : QUEUE_PARALLEL_LIMIT }, () => worker()));
    await transaction(async state => { state.queueReasons = planReservations(state, currentTime()).reasons; await commit(state); });
  }

  // The button authorizes this single pass only. It does not enable a stored
  // automatic-posting switch or resume paused queues. One shared promise also
  // prevents clicks, other tabs and the timer from overlapping submissions.
  function startQueueRun(source = 'manual') {
    if (queueRunPending) return;
    queueStopRequested = false; queueStoppedAccounts.clear();
    queueRunMode = envelope.mode;
    const runMode = queueRunMode;
    queueRunProgress = { id: randomUUID(), running: true, source, startedAt: currentTime(), completedAt: null,
      reserved: 0, published: 0, failed: 0, needsReview: 0, remaining: active().jobs.filter(job => job.status === 'queued').length,
      errors: [], message: '正在核对 Pixiv 状态并提交可预约的作品。' };
    queueRunPending = serialize(async () => {
      const run = queueRunProgress;
      const before = clone(active().jobs);
      let stoppedMessage = '';
      try {
        if (runMode !== envelope.mode) fail('工作空间已切换，本轮未开始预约。', 409);
        active().queueRun = clone(run);
        await persist();
        if (active().settings.queuePaused) stoppedMessage = '预约队列已暂停；恢复队列后可开始预约。';
        else if (!active().jobs.some(job => ['queued', 'reserved', 'uploading', 'needs_review'].includes(job.status))) stoppedMessage = '没有待补位或需要核对的作品。';
        else await tick({ manualStart: source === 'manual', errors: run.errors });
      } catch (error) {
        run.errors.push({ message: String(error.message || '本轮预约未完成。').slice(0, 1000) });
        stoppedMessage = String(error.message || '本轮预约未完成。').slice(0, 1000);
      } finally {
        const runState = envelope.states[runMode];
        const completedAt = new Date(nowProvider()).toISOString();
        const result = summarizeQueueRun(before, runState.jobs, { ...run, completedAt });
        if (stoppedMessage) result.message = stoppedMessage;
        else if (queueStopRequested || queueStoppedAccounts.size) result.message += ' 已停止暂停范围内的后续提交。';
        runState.queueRun = result;
        runState.queueAutomation = { intervalMs: QUEUE_CHECK_INTERVAL_MS, nextCheckAt: nextQueueCheck(completedAt) };
        log(runState, `${source === 'manual' ? '手动' : '自动'}预约：${result.message}`, result.errors.length || result.failed || result.needsReview ? 'warning' : 'info', completedAt);
        await persist();
        queueRunProgress = result;
      }
    }).catch(error => console.error('Queue:', error.message)).finally(() => {
      queueRunPending = null; queueRunProgress = null; queueRunMode = null;
      queueStopRequested = false; queueStoppedAccounts.clear();
    });
  }

  const server = http.createServer(async (req, res) => {
    activeRequests++;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    try {
      const port = server.address()?.port;
      if (![`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(req.headers.host)) fail('仅允许通过本机地址访问。', 403);
      if (req.headers.origin) {
        let origin;
        try { origin = new URL(req.headers.origin); } catch { fail('请求来源无效。', 403); }
        if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) || origin.port !== String(port)) fail('已拒绝跨站请求。', 403);
      }
      if (req.headers['sec-fetch-site'] === 'cross-site') fail('已拒绝跨站请求。', 403);
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      const pathname = decodeURIComponent(url.pathname);
      if (closing) fail('应用正在安全退出，请稍后重新打开。', 503);
      if (req.method === 'POST' && pathname === '/api/service/stop') {
        const supplied = req.headers['x-atelier-launcher'];
        if (!/^[a-f0-9]{64}$/.test(launcherToken) || typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied)
          || !timingSafeEqual(Buffer.from(launcherToken), Buffer.from(supplied))) fail('只能使用本应用启动器安全退出。', 403);
        await jsonBody(req);
        const busy = () => queueRunPending || pixivSyncPending || dedicatedChangePending || analyticsCollector.status().running || activeRequests > 1;
        if (busy()) fail('当前仍在投稿、同步或处理请求，请等待任务完成后再退出。', 409);
        // Set this before yielding: timer callbacks and new requests cannot
        // start work between the idle check and durable shutdown.
        closing = true;
        try {
          await serialize(async () => {
            if (busy()) fail('后台任务尚未结束，请稍后再退出。', 409);
            await persist();
          });
        } catch (error) { closing = false; throw error; }
        res.once('finish', () => { server.close(); server.closeIdleConnections?.(); });
        return json(res, 202, { stopping: true });
      }
      if (req.method === 'GET' && pathname === '/api/health') return json(res, 200, { ok: true, app: 'pixiv-publisher', mode: envelope.mode, connectorConfigured: Boolean(connectorUrl) || browserConfigured() });
      if (req.method === 'GET' && pathname === '/api/state') { if (!queueRunPending) await chain; return json(res, 200, publicState()); }
      if (req.method === 'GET' && pathname === '/api/analytics/status') return json(res, 200, analyticsStatus());
      if (req.method === 'GET' && pathname === '/api/analytics') {
        const queryFields = new Set(['accountId', 'point', 'group', 'metric', 'sort', 'query', 'offset', 'limit', 'days', 'dailyDays']);
        for (const key of url.searchParams.keys()) if (!queryFields.has(key)) fail('统计查询参数无效。');
        const input = Object.fromEntries(url.searchParams);
        for (const [key, values] of Object.entries({ point: ['current', '6h', '12h', '24h', '7d'], group: ['work', 'character', 'tag', 'interval'],
          metric: ['views', 'bookmarks', 'likes', 'bookmarkRate'], sort: ['total', 'average', 'growth'], days: ['all', '30', '90', '180', '365'], dailyDays: ['7', '30', '90', '365'] })) if (input[key] !== undefined) enumValue(input[key], values, `统计${key}`);
        for (const key of ['offset', 'limit']) if (input[key] !== undefined && (!/^\d+$/.test(input[key]) || !Number.isSafeInteger(Number(input[key])) || Number(input[key]) > (key === 'limit' ? 200 : 1000000))) fail('统计分页范围无效。');
        if (input.query !== undefined) string(input.query, '统计搜索', 200);
        const scope = analyticsScope(input.accountId || 'all');
        const report = analyticsStore.report({ ...input, ...scope });
        const byKey = new Map(scope.accounts.map(account => [analyticsAccountKey(account), account]));
        report.filters.accountId = input.accountId || 'all';
        for (const row of report.rows) if (row.accountId) {
          const key = row.accountId, account = byKey.get(key);
          row.accountId = account?.id; row.accountName = account?.name;
          if (row.hasThumbnail && account) {
            const source = analyticsStore.getWorkThumbnail({ accountId: key, artworkId: row.artworkId });
            if (source) {
              const version = createHash('sha256').update(key + source).digest('hex').slice(0, 12);
              row.thumbnailUrl = `/api/analytics/accounts/${encodeURIComponent(account.id)}/works/${row.artworkId}/thumbnail?v=${version}`;
            }
          }
        }
        const accountRecords = new Map(report.accounts.map(record => [record.accountId, record]));
        report.accounts = scope.accounts.filter(account => !input.accountId || input.accountId === 'all' || input.accountId === account.id)
          .map(account => ({ ...(accountRecords.get(analyticsAccountKey(account)) || { latest: null, history: [] }), accountId: account.id, name: account.name }));
        return json(res, 200, { ...report, mode: envelope.mode });
      }
      if (req.method === 'POST' && pathname === '/api/analytics/collect') {
        const input = object(await jsonBody(req));
        if (dedicatedChangePending) fail('正在切换专用 Chrome，请完成登录确认后再采集数据。', 409);
        if (envelope.mode !== 'live') fail('请切换到正式模式后采集真实 Pixiv 数据。', 409);
        const accountId = input.accountId ?? 'all'; analyticsScope(accountId);
        if (!active().accounts.some(account => (accountId === 'all' || account.id === accountId) && account.browser?.targetId)) fail('请先在账号管理中连接 Chrome。', 409);
        analyticsCollector.start({ accountId, force: true });
        return json(res, 202, analyticsStatus());
      }
      const thumbnailRoute = /^\/api\/analytics\/accounts\/([a-z0-9-]+)\/works\/(\d{1,20})\/thumbnail$/i.exec(pathname);
      if (req.method === 'GET' && thumbnailRoute) {
        const [, accountId, artworkId] = thumbnailRoute;
        const contextVersion = tagPoolContextVersion;
        const account = envelope.mode === 'live' && active().accounts.find(item => item.id === accountId);
        if (!account) fail('作品缩略图不可用。', 404);
        const key = analyticsAccountKey(account);
        const source = analyticsStore.getWorkThumbnail({ accountId: key, artworkId });
        if (!source) fail('作品缩略图尚未采集。', 404);
        const cacheKey = key + ':' + artworkId + ':' + source;
        let cached = thumbnailCache.get(cacheKey);
        if (!cached || cached.expiresAt <= Date.now()) {
          if (!thumbnailPending.has(cacheKey)) {
            if (thumbnailPending.size >= 100) fail('缩略图正在加载，请稍后重试。', 503);
            const pending = thumbnailSlot(async () => {
              try {
                const value = await fetchArtworkThumbnail({ artworkId, thumbnailUrl: source }, { fetchImpl: options.thumbnailFetch ?? globalThis.fetch });
                return { ...value, expiresAt: Date.now() + QUEUE_CHECK_INTERVAL_MS };
              } catch { return { unavailable: true, expiresAt: Date.now() + 60000 }; }
            }).then(value => {
              if (thumbnailCache.size >= 64) thumbnailCache.delete(thumbnailCache.keys().next().value);
              thumbnailCache.set(cacheKey, value); return value;
            }).finally(() => thumbnailPending.delete(cacheKey));
            thumbnailPending.set(cacheKey, pending);
          }
          cached = await thumbnailPending.get(cacheKey);
        }
        if (envelope.mode !== 'live' || tagPoolContextVersion !== contextVersion || !active().accounts.some(item => item.id === accountId && analyticsAccountKey(item) === key)) fail('作品缩略图不可用。', 404);
        if (cached.unavailable) fail('暂时无法显示作品缩略图。', 502);
        res.writeHead(200, { 'Content-Type': cached.contentType, 'Content-Length': cached.bytes.length,
          'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
        return res.end(cached.bytes);
      }
      if (req.method === 'POST' && pathname === '/api/queue/start') {
        await jsonBody(req);
        startQueueRun('manual');
        return json(res, 202, publicState());
      }
      if (req.method === 'GET' && /^\/api\/accounts\/[^/]+\/avatar$/.test(pathname)) {
        const account = active().accounts.find(item => item.id === pathname.split('/')[3]);
        const source = normalizeAvatarUrl(account?.avatarUrl);
        if (!source) fail('此账号尚未同步头像。', 404);
        let cached = avatarCache.get(source);
        if (!cached || Date.now() - cached.at > QUEUE_CHECK_INTERVAL_MS) {
          const avatar = await fetchAvatar(source, { fetchImpl: options.avatarFetch ?? globalThis.fetch });
          cached = { ...avatar, at: Date.now() };
          if (avatarCache.size >= 100) avatarCache.delete(avatarCache.keys().next().value);
          avatarCache.set(source, cached);
        }
        res.writeHead(200, { 'Content-Type': cached.contentType, 'Content-Length': cached.bytes.length,
          'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
        return res.end(cached.bytes);
      }
      if (req.method === 'GET' && pathname === '/api/tagger/status') return json(res, 200, await refreshTaggerStatus(true));
      if (req.method === 'GET' && pathname === '/api/characters') {
        return json(res, 200, await serialize(async () => ({ mode: envelope.mode, characters: await characterMemory.list({ mode: envelope.mode }) })));
      }
      if (req.method === 'GET' && pathname === '/api/characters/templates') {
        return json(res, 200, await serialize(async () => {
          const snapshot = captureTagPool(url.searchParams.get('accountId'), url.searchParams.get('mode') ?? undefined);
          return postingCatalog(snapshot);
        }));
      }
      if (req.method === 'POST' && pathname === '/api/characters/remember') {
        const input = await jsonBody(req);
        return json(res, 200, await serialize(() => rememberCharacter(input)));
      }
      if (req.method === 'POST' && pathname === '/api/characters/resolve') {
        return json(res, 200, await resolveCharacterTags(await jsonBody(req)));
      }
      if (req.method === 'DELETE' && /^\/api\/characters\/[^/]+$/.test(pathname)) {
        return json(res, 200, await serialize(async () => {
          if (url.searchParams.get('mode') !== envelope.mode) fail('工作空间已经切换，请重新打开角色记忆。', 409);
          if (!await characterMemory.forget({ mode: envelope.mode, id: pathname.split('/')[3] })) fail('此角色记忆已不存在，请刷新。', 404);
          return { mode: envelope.mode, characters: await characterMemory.list({ mode: envelope.mode }) };
        }));
      }
      if (req.method === 'POST' && pathname === '/api/pixiv/sync') {
        await jsonBody(req);
        if (pixivSyncPending) fail('正在同步 Pixiv 状态，请等待本次同步完成。', 409);
        pixivSyncPending = true;
        try { return json(res, 200, await serialize(() => syncPixivStatus())); }
        finally { pixivSyncPending = false; }
      }
      if (req.method === 'GET' && pathname === '/api/tags/pool') {
        return json(res, 200, await serialize(() => {
          const snapshot = captureTagPool(url.searchParams.get('accountId'), url.searchParams.get('mode') ?? undefined);
          return tagPools.get(snapshot.scope, { jobs: active().jobs });
        }));
      }
      if (req.method === 'POST' && pathname === '/api/tags/pool') {
        const input = await jsonBody(req);
        return json(res, 200, await serialize(() => {
          const snapshot = captureTagPool(input.accountId, enumValue(input.mode, ['demo', 'live'], '运行模式'));
          return tagPools.edit(snapshot.scope, { addTags: input.addTags, removeTags: input.removeTags, jobs: active().jobs });
        }));
      }
      if (req.method === 'POST' && pathname === '/api/tags/pool/sync') {
        const input = await jsonBody(req);
        if (input.fullHistory !== undefined && typeof input.fullHistory !== 'boolean') fail('历史同步选项无效。');
        const fullHistory = input.fullHistory === true;
        const historyOffset = input.historyOffset ?? 0;
        const historyLimit = input.historyLimit ?? 2000;
        if (fullHistory && (!Number.isInteger(historyOffset) || historyOffset < 0 || historyOffset > 1000000
          || !Number.isInteger(historyLimit) || historyLimit < 1 || historyLimit > 2000)) fail('历史同步范围无效。');
        const snapshot = await serialize(() => captureTagPool(input.accountId, enumValue(input.mode, ['demo', 'live'], '运行模式')));
        if (snapshot.scope.mode !== 'live') fail('演示账号不能同步真实 Pixiv 常用标签。', 409);
        if (!snapshot.account.browser?.targetId || !browserConnector.searchTags) fail('请先为此账号连接已登录的 Chrome 标签页。', 409);
        let searched;
        try { searched = await browserConnector.searchTags(snapshot.account, [], fullHistory
          ? { includeHistory: true, fullHistory: true, historyOffset, historyLimit, historyTimeBudgetMs: 120000 }
          : { includeHistory: true, historyLimit: 60 }); }
        catch (error) { fail(`常用标签同步未完成：${error.message} 已保留原有标签池。`, error.status || 503); }
        return json(res, 200, await serialize(() => saveTagPool(snapshot, searched)));
      }
      if (req.method === 'POST' && pathname === '/api/tags/search') {
        const input = await jsonBody(req);
        const account = await serialize(() => { if(envelope.mode!=='live')fail('全站标签搜索需要真实账号。',409);return clone(active().accounts.find(a=>a.id===input.accountId)); });
        if(!account)fail('请选择投稿账号。');
        const word=string(input.word,'搜索标签',64,false);
        const result=await browserConnector.searchTags(account,[word]);
        const preferred=new Map(result.frequentTags.map((tag,i)=>[tag,i]));
        return json(res,200,{...result,candidates:result.matches.map(m=>({...m,preferred:preferred.has(m.tag)})).sort((a,b)=>Number(b.preferred)-Number(a.preferred)||(preferred.get(a.tag)??10000)-(preferred.get(b.tag)??10000))});
      }
      if (req.method === 'POST' && pathname === '/api/tags/suggest') {
        const input = await jsonBody(req);
        const snapshot = await serialize(() => captureTagRequest(input));
        // Inference works from an immutable snapshot, outside the state-write
        // queue, so a slow model cannot block scheduling or account updates.
        return json(res, 200, await suggestTags(snapshot));
      }
      if (req.method === 'POST' && pathname === '/api/files') {
        const modeAtUpload = envelope.mode;
        const name = string(url.searchParams.get('name') ?? 'image', '文件名', 255, false);
        const data = await body(req, IMAGE_LIMIT);
        const detected = identifyImage(data);
        const uploaded = await serialize(async () => {
          const id = randomUUID(), diskName = `${id}${detected.extension}`;
          const file = { id, name: path.basename(name.replaceAll('\\', '/')), url: `/files/${id}`, mime: detected.mime, size: data.length };
          await fs.writeFile(path.join(uploadDir, diskName), data, { mode: 0o600 });
          envelope.uploads[id] = { ...file, mode: modeAtUpload, diskName };
          await persist(); return file;
        });
        return json(res, 201, { file: uploaded });
      }
      if (pathname.startsWith('/api/')) {
        if (!['POST', 'PATCH', 'DELETE'].includes(req.method)) fail('接口不存在。', 404);
        const input = req.method === 'DELETE' ? {} : await jsonBody(req);
        // Honor a pause as soon as its validated request arrives, even while
        // a current round owns the serialized persistence queue. An already
        // submitted work is still reconciled; subsequent clicks are stopped.
        if (queueRunPending && queueRunMode === envelope.mode && req.method === 'PATCH') {
          if (pathname === '/api/settings' && input.queuePaused === true) queueStopRequested = true;
          if (/^\/api\/accounts\/[^/]+$/.test(pathname) && input.paused === true
            && active().accounts.some(account => account.id === pathname.split('/')[3])) queueStoppedAccounts.add(pathname.split('/')[3]);
        }
        const result = await serialize(async () => {
          let state = active(); const now = currentTime();
          let createdJobId;
          if (pathname === '/api/browser/dedicated/setup' && req.method === 'POST') {
            requireDedicatedChange();
            for (const account of state.accounts) requireDedicatedChange(account);
            for (const account of state.accounts) if (account.browser?.mode !== 'dedicated') pendingDedicated(account);
            log(state, '已为账号启用独立的专用 Chrome，请分别登录并确认账号。', 'info', now);
          } else if (/^\/api\/accounts\/[^/]+\/browser-dedicated\/(open|verify|background)$/.test(pathname) && req.method === 'POST') {
            const account = state.accounts.find(a => a.id === pathname.split('/')[3]);
            if (!account) fail('账号不存在。', 404);
            requireDedicatedChange(account);
            const action = pathname.split('/').at(-1);
            if (action !== 'open' && account.browser?.mode !== 'dedicated') fail('请先启用此账号的专用 Chrome。', 409);
            const original = clone(account);
            dedicatedChangePending = true;
            try {
              pendingDedicated(account);
              await persist();
              if (action === 'open') {
                await browserConnector.openDedicatedLogin(account);
                account.browser.runtimeMode = 'interactive';
                log(state, `${account.name}：已打开专用 Chrome 登录窗口，请登录 Pixiv ${account.pixivUserId}。`, 'info', now);
              } else {
                const result = action === 'background' ? await browserConnector.backgroundDedicated(original) : await browserConnector.verifyDedicated(account);
                state = acceptDedicated(account, result, now);
                log(state, `${account.name}：${action === 'background' ? '已转入后台运行' : '已确认专用 Chrome 登录身份'}。`, 'success', now);
              }
            } catch (error) {
              account.connected = false; account.browser.postingEnabled = false; account.browser.loginPending = true;
              account.remote.syncOk = false; account.remote.error = error.message;
              log(active(), `${account.name}：${error.message}`, 'error', now);
              await persist(); throw error;
            } finally { dedicatedChangePending = false; }
          } else if (pathname === '/api/browser/discover' && req.method === 'POST') {
            if (envelope.mode !== 'live') fail('请先切换到真实工作空间。', 409);
            return browserConnector.discover();
          } else if (/^\/api\/accounts\/[^/]+\/browser$/.test(pathname) && req.method === 'POST') {
            if (envelope.mode !== 'live') fail('演示账号不能连接真实 Chrome。', 409);
            if (connectorUrl) fail('当前使用外部连接器，请先移除 PIXIV_CONNECTOR_URL 配置再使用内置 Chrome 连接。', 409);
            const account = state.accounts.find(a => a.id === pathname.split('/')[3]);
            if (!account) fail('账号不存在。', 404);
            const result = await browserConnector.bind(account, string(input.candidateId, '浏览器账号', 100, false));
            if (state.accounts.some(a => a.id !== account.id && a.browser?.targetId && a.pixivUserId === result.account.pixivUserId)) fail('这个 Pixiv 账号已绑定其他本地账号资料，请使用原账号。', 409);
            Object.assign(account, result.account, { connected: true, premium: result.snapshot.premium });
            captureAvatar(account, result.snapshot);
            tagPoolContextVersion++;
            state = reconcileRemote(state, account.id, result.snapshot, now); replaceState(state);
            log(state, `已连接 Chrome：${account.name} · Pixiv ${account.pixivUserId}。浏览器投稿需单独开启。`, 'success', now);
          } else if (/^\/api\/accounts\/[^/]+\/browser-sync$/.test(pathname) && req.method === 'POST') {
            if (envelope.mode !== 'live') fail('请先切换到真实工作空间。', 409);
            const account = state.accounts.find(a => a.id === pathname.split('/')[3]);
            if (!account) fail('账号不存在。', 404);
            try {
              const snapshot = await browserSnapshot(account);
              account.connected = snapshot.connected === true; account.premium = snapshot.premium === true;
              state = reconcileRemote(state, account.id, snapshot, now); replaceState(state);
              log(state, `${account.name}：已核对登录身份，远端预约 ${snapshot.total} 件。`, 'success', now);
            } catch (error) {
              account.connected = false; account.remote.syncOk = false; account.remote.error = error.message;
              if (account.browser && postingIdentityLost(error)) account.browser.postingEnabled = false;
              log(state, `${account.name}：${error.message}`, 'error', now); await persist(); throw error;
            }
          } else if (/^\/api\/accounts\/[^/]+\/browser-posting$/.test(pathname) && req.method === 'POST') {
            if (envelope.mode !== 'live') fail('请先切换到真实工作空间。', 409);
            const account = state.accounts.find(a => a.id === pathname.split('/')[3]);
            if (!account?.browser?.targetId) fail('账号尚未绑定 Chrome。', 409);
            const enabled = bool(input.enabled, '浏览器投稿开关');
            if (enabled && account.browser.mode === 'dedicated' && account.browser.loginPending) fail('请先确认专用 Chrome 登录身份。', 409);
            if (enabled) {
              const snapshot = await browserSnapshot(account);
              if (!snapshot.connected || !snapshot.premium) fail('需先确认账号已登录且已开通 Premium。', 409);
              account.connected = true; account.premium = true;
              state = reconcileRemote(state, account.id, snapshot, now); replaceState(state);
            }
            state.accounts.find(a => a.id === account.id).browser.postingEnabled = enabled;
            log(state, `${account.name}：${enabled ? '已开启' : '已关闭'}浏览器投稿。`, 'info', now);
          } else if (/^\/api\/jobs\/[^/]+\/browser-reconcile$/.test(pathname) && req.method === 'POST') {
            if (envelope.mode !== 'live') fail('请先切换到真实工作空间。', 409);
            const job = state.jobs.find(j => j.id === pathname.split('/')[3]);
            if (!job || !['reserved', 'needs_review', 'uploading'].includes(job.status)) fail('作品不需要核对远端结果。', 409);
            const account = state.accounts.find(a => a.id === job.accountId);
            const snapshot = await browserConnector.reconcile(account, job, {
              remoteId: string(input.remoteId || '', '远端预约 ID', 100), artworkUrl: string(input.artworkUrl || '', '作品链接', 200),
              adoptRemoteSchedule: own(input,'adoptRemoteSchedule') ? bool(input.adoptRemoteSchedule,'采用远端排期') : false,
            });
            if (input.adoptRemoteSchedule === true) {
              const remote = snapshot.reservations.find(r=>r.remoteId===input.remoteId&&r.remoteId===job.remoteId&&r.jobId===job.id&&r.status==='reserved');
              if (!remote?.scheduledAt || !Number.isFinite(Date.parse(remote.scheduledAt))) fail('未找到可采用的已关联预约时间。',409);
              job.scheduledAt = remote.scheduledAt; job.timezone='Asia/Tokyo';
            }
            state = reconcileRemote(state, account.id, snapshot, now); replaceState(state);
            log(state, `已核对 Pixiv 记录：${job.title}`, 'success', now);
          } else if (/^\/api\/jobs\/[^/]+\/preflight$/.test(pathname) && req.method === 'POST') {
            if (envelope.mode !== 'live') fail('演示作品不使用真实浏览器。', 409);
            const job = state.jobs.find(j => j.id === pathname.split('/')[3]);
            if (!job) fail('作品不存在。', 404);
            const account = state.accounts.find(a => a.id === job.accountId);
            return browserConnector.preflight(account, job);
          } else if (pathname === '/api/mode' && req.method === 'POST') {
            const nextMode = enumValue(input.mode, ['demo', 'live'], '运行模式');
            if (envelope.mode !== nextMode) tagPoolContextVersion++;
            envelope.mode = nextMode;
          } else if (pathname === '/api/settings' && ['POST', 'PATCH'].includes(req.method)) {
            const nextSettings = { ...state.settings };
            if (own(input, 'queuePaused')) nextSettings.queuePaused = bool(input.queuePaused, '暂停队列');
            if (own(input, 'timezone')) nextSettings.timezone = timezone(input.timezone);
            state.settings = nextSettings;
          } else if (pathname === '/api/accounts' && req.method === 'POST') {
            const name = string(input.name, '账号别名', 60, false);
            const pixivUserId = string(input.pixivUserId ?? '', 'pixiv 用户 ID', 30);
            if (pixivUserId && !/^\d+$/.test(pixivUserId)) fail('pixiv 用户 ID 只能包含数字。');
            if (state.accounts.length >= 100) fail('最多支持 100 个本地账号。');
            state.accounts.push({ id: randomUUID(), name, pixivUserId, avatarColor: '#899880', demo: state.settings.demo,
              connected: state.settings.demo, premium: state.settings.demo, paused: false,
              timezone: 'Asia/Tokyo', defaultPostingTime: postingTime(input.defaultPostingTime ?? defaultPostingTime({name,pixivUserId})), remote: { syncOk: state.settings.demo, syncedAt: state.settings.demo ? now : null, total: 0, reservations: [] } });
            log(state, `已添加${state.settings.demo ? '演示' : '本地'}账号：${name}`, 'info', now);
          } else if (/^\/api\/accounts\/[^/]+$/.test(pathname)) {
            const id = pathname.split('/').at(-1), existing = state.accounts.find(item => item.id === id), account = existing ? clone(existing) : null;
            if (!account) fail('账号不存在。', 404);
            if (req.method === 'DELETE') {
              if (state.jobs.some(job => job.accountId === id && !['published', 'cancelled'].includes(job.status))) fail('此账号还有作品，请先处理作品再移除账号。', 409);
              state.accounts = state.accounts.filter(item => item.id !== id);
              tagPoolContextVersion++;
            } else if (req.method === 'PATCH') {
              if (own(input, 'name')) account.name = string(input.name, '账号别名', 60, false);
              if (own(input, 'paused')) account.paused = bool(input.paused, '账号暂停');
              if (own(input, 'defaultPostingTime')) account.defaultPostingTime = postingTime(input.defaultPostingTime);
              if (own(input, 'timezone')) account.timezone = timezone(input.timezone);
              if (own(input, 'pixivUserId')) {
                const value = string(input.pixivUserId, 'pixiv 用户 ID', 30);
                if (value && !/^\d+$/.test(value)) fail('pixiv 用户 ID 只能包含数字。');
                if (value !== account.pixivUserId && state.jobs.some(job => job.accountId === id && ['uploading', 'reserved', 'needs_review'].includes(job.status))) fail('账号有远端预约或待核对作品，不能修改绑定 ID。', 409);
                if (value !== account.pixivUserId && !state.settings.demo) { account.connected = false; account.remote.syncOk = false; delete account.browser; }
                if (value !== account.pixivUserId) { tagPoolContextVersion++; delete account.avatarUrl; delete account.avatarCheckedAt; }
                account.pixivUserId = value;
              }
              state.accounts[state.accounts.findIndex(item => item.id === id)] = account;
            } else fail('不支持的操作。', 405);
          } else if (pathname === '/api/jobs/bulk-delete' && req.method === 'POST') {
            const mode = enumValue(input.mode, ['demo', 'live'], '运行模式');
            if (mode !== envelope.mode) fail('工作空间已经切换，请刷新后重新选择要删除的作品。', 409);
            if (!Array.isArray(input.jobIds) || input.jobIds.length < 1 || input.jobIds.length > 200) fail('请一次选择 1–200 件本地作品。');
            const jobIds = input.jobIds.map(id => string(id, '作品标识', 100, false));
            if (new Set(jobIds).size !== jobIds.length) fail('删除列表中不能包含重复作品。');
            const jobs = jobIds.map(id => {
              const matches = state.jobs.filter(job => job.id === id);
              if (!matches.length) fail('部分作品已不存在，请刷新后重新选择。', 404);
              if (matches.length !== 1) fail('作品标识重复，需先检查本地记录。', 409);
              return matches[0];
            });
            for (const job of jobs) {
              const reason = localJobDeletionReason(job, state);
              if (reason) fail(`“${job.title || '未命名作品'}”不能删除：${reason}`, 409, { jobId: job.id });
            }
            const removed = new Set(jobIds), nextEnvelope = clone(envelope), nextState = nextEnvelope.states[mode];
            nextState.jobs = nextState.jobs.filter(job => !removed.has(job.id));
            nextState.queueReasons = planReservations(nextState, now).reasons;
            log(nextState, `已删除 ${jobIds.length} 件本地作品。`, 'info', now);
            // Commit to disk first. A failed write must leave every selected
            // work, its queue state, and the live in-memory state intact.
            await persist(nextEnvelope);
            envelope = nextEnvelope;
            return { ...publicState(), deletedJobIds: jobIds };
          } else if (pathname === '/api/jobs' && req.method === 'POST') {
            if (state.jobs.length >= 10000) fail('本地作品数已达上限。');
            const createdJob = sanitizeJob(input, null, state, envelope.uploads, now);
            state.jobs.push(createdJob);
            createdJobId = createdJob.id;
          } else if (/^\/api\/jobs\/[^/]+$/.test(pathname)) {
            const id = pathname.split('/').at(-1), index = state.jobs.findIndex(item => item.id === id), job = state.jobs[index];
            if (!job) fail('作品不存在。', 404);
            const localExpired = job.status === 'needs_review' && job.reviewReason === 'schedule_expired' && !job.remoteId && !job.uploadStartedAt;
            const definitiveFailure = job.status === 'failed' && job.uploadOutcome === 'not_uploaded' && !job.remoteId;
            const editableLocal = EDITABLE.has(job.status) && !job.remoteId && (!job.uploadStartedAt || job.uploadOutcome === 'not_uploaded');
            if (!editableLocal && !localExpired && !definitiveFailure) fail('作品已进入远端流程，需先在 pixiv 核对；只有明确尚未上传的失败作品才能重排。', 409);
            if (req.method === 'DELETE') { job.status = 'cancelled'; job.updatedAt = now; log(state, `已取消本地作品：${job.title || '未命名作品'}`, 'info', now); }
            else if (req.method === 'PATCH') state.jobs[index] = sanitizeJob(input, job, state, envelope.uploads, now);
            else fail('不支持的操作。', 405);
          } else if (pathname === '/api/queue/tick' && req.method === 'POST') {
            await tick();
          } else if (pathname === '/api/demo/reset' && req.method === 'POST') {
            if (envelope.mode !== 'demo') fail('请切换到演示模式后重置。', 409);
            envelope.states.demo = createDemoState(nowProvider());
          } else if (pathname === '/api/demo/advance' && req.method === 'POST') {
            if (!state.settings.demo) fail('仅演示模式支持推进时间。', 409);
            let reserved = state.jobs.filter(job => job.status === 'reserved');
            if (!reserved.length && state.jobs.some(job => job.status === 'queued')) { await tick(); state = active(); reserved = state.jobs.filter(job => job.status === 'reserved'); }
            if (!reserved.length) fail('当前没有可模拟发布的预约作品。', 409);
            const nextTime = Math.min(...reserved.map(job => Date.parse(job.scheduledAt)));
            state.settings.demoNow = new Date(Math.max(Date.parse(now), nextTime)).toISOString();
            let published = 0;
            for (const account of state.accounts) for (const reservation of account.remote.reservations) {
              if (reservation.status === 'reserved' && Date.parse(reservation.scheduledAt) <= nextTime) { reservation.status = 'published'; reservation.publishedAt = state.settings.demoNow; published++; }
            }
            log(state, `演示发布确认：${published} 件作品已模拟发布，正在补充空出的预约位置。没有真实投稿。`, 'success', state.settings.demoNow);
            await tick();
          } else fail('接口不存在。', 404);
          await persist(); return { ...publicState(), ...(createdJobId ? { createdJobId } : {}) };
        });
        return json(res, 200, result);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') fail('不支持的操作。', 405);
      let filePath, contentType;
      if (pathname.startsWith('/files/')) {
        const id = pathname.slice('/files/'.length);
        if (!/^[a-z0-9-]+$/i.test(id) || !envelope.uploads[id] || envelope.uploads[id].mode !== envelope.mode) fail('图片不存在或不属于当前模式。', 404);
        const uploaded = envelope.uploads[id];
        filePath = path.join(uploadDir, uploaded.diskName); contentType = uploaded.mime;
      } else {
        if (pathname.includes('\\') || pathname.includes('\0')) fail('文件路径无效。');
        const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
        filePath = path.resolve(publicDir, relative);
        if (!filePath.startsWith(`${publicDir}${path.sep}`)) fail('不允许访问此路径。', 403);
        contentType = MIME[path.extname(filePath)] ?? 'application/octet-stream';
      }
      let file;
      try { file = await fs.readFile(filePath); } catch (error) { if (error.code === 'ENOENT' || error.code === 'EISDIR') fail('文件不存在。', 404); throw error; }
      res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': pathname.startsWith('/files/') ? 'no-store' : 'no-cache', 'Content-Length': file.length });
      res.end(req.method === 'HEAD' ? undefined : file);
    } catch (error) {
      if (!res.headersSent) json(res, error.status ?? 500, { error: error.status ? error.message : '本地服务发生错误。请检查服务日志。', ...(error.details ? { details: error.details } : {}) });
      else res.end();
      if (!error.status) console.error(error);
    } finally { activeRequests--; }
  });
  let timer;
  if (options.background !== false) {
    timer = setInterval(() => {
      if (closing) return;
      // This minute timer checks local deadlines only. Queue/full statistics
      // run six-hourly; individual publication milestones run when due.
      if (!dedicatedChangePending) analyticsCollector.start();
      if (!queueRunPending && !pixivSyncPending && !dedicatedChangePending && envelope.mode === 'live') {
        // A due queue run already reads all account snapshots, including paused
        // accounts. Reuse that review instead of starting a duplicate read pass.
        if ((connectorUrl || active().accounts.some(a => a.browser?.postingEnabled)) && !active().settings.queuePaused
          && Date.parse(currentTime()) >= Date.parse(active().queueAutomation.nextCheckAt)) startQueueRun('automatic');
        else if (Date.parse(currentTime()) >= Date.parse(active().publicationReviewAutomation.nextCheckAt)) startPublicationReview();
      }
    }, options.pollInterval ?? 60000);
    timer.unref();
  }
  server.on('close', () => {
    closing = true;
    clearInterval(timer);
    server.analyticsClosed = analyticsCollector.close().finally(() => analyticsStore.close());
    server.shutdownComplete = Promise.allSettled([server.analyticsClosed, persistChain,
      Promise.resolve(browserConnector.close?.()).catch(error => console.error('Browser close:', error.message)),
      Promise.resolve(tagger.close?.()).catch(error => console.error('Tagger close:', error.message))]);
  });
  server.requestTimeout = 60000;
  server.headersTimeout = 30000;
  // Keep the promise available for shutdown/tests, while listening can begin
  // immediately even if model hashing or ONNX initialization takes minutes.
  server.taggerStatusReady = refreshTaggerStatus();
  server.analytics = { store: analyticsStore, collector: analyticsCollector };
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 4318);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 无效。');
  const server = await createServer();
  server.listen(port, '127.0.0.1', () => console.log(`Pixiv Publisher: http://127.0.0.1:${port}（默认本地演示模式）`));
}
