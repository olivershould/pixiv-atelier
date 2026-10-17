/**
 * Pure reservation planning. These functions never contact Pixiv or infer that
 * an illustration was published merely because its scheduled time has passed.
 * Persist an action as `uploading` BEFORE calling a connector, and reconcile its
 * actual outcome. Reusing a plan requires the same idempotency key.
 */
export const RESERVATION_LIMIT = 10;
export const RESERVATION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const SNAPSHOT_MAX_AGE_MS = 5 * 60 * 1000;
export const UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;
export const PIXIV_TIMEZONE = 'Asia/Tokyo';
export const JOB_STATUSES = Object.freeze([
  'draft', 'queued', 'uploading', 'reserved', 'published', 'failed', 'needs_review', 'cancelled',
]);

function instant(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (typeof value !== 'string') return NaN;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/i.exec(value);
  if (!match) return NaN;
  const [, year, month, day, hour, minute, second = '0', , offset] = match;
  const parts = [year, month, day, hour, minute, second].map(Number);
  const [y, m, d, h, min, s] = parts;
  if (m < 1 || m > 12 || d < 1 || h > 23 || min > 59 || s > 59) return NaN;
  const calendar = new Date(Date.UTC(y, m - 1, d, h, min, s));
  if (calendar.getUTCFullYear() !== y || calendar.getUTCMonth() !== m - 1 || calendar.getUTCDate() !== d) return NaN;
  if (offset.toUpperCase() !== 'Z') {
    const oh = Number(offset.slice(1, 3));
    const om = Number(offset.slice(4, 6));
    if (oh > 14 || om > 59 || (oh === 14 && om !== 0)) return NaN;
  }
  return Date.parse(value);
}

function clock(now) {
  const value = instant(now);
  if (!Number.isFinite(value)) throw new TypeError('now 必须是有效的绝对时间。');
  return value;
}

function validTimezone(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(0); return true; }
  catch { return false; }
}

function reservationKey(job) {
  return job.idempotencyKey || `pixiv-reservation:${encodeURIComponent(job.accountId)}:${encodeURIComponent(job.id)}:v${job.reservationAttempt || 1}`;
}

function matches(job, record) {
  if (record.accountId && record.accountId !== job.accountId) return false;
  // A retry is a new explicit attempt, not a replay of a previous failed result.
  // On subsequent attempts, a bare jobId is insufficient to identify a record.
  if (record.idempotencyKey) return record.idempotencyKey === reservationKey(job);
  if (job.remoteId) return job.remoteId === (record.remoteId || record.id);
  return (!job.reservationAttempt || job.reservationAttempt === 1) && record.jobId && record.jobId === job.id;
}

function list(state, field) {
  return Array.isArray(state?.[field]) ? state[field] : [];
}

// A new side effect needs an exhaustive account snapshot. Older external
// adapters may omit identity, but an explicitly conflicting identity is never
// acceptable. Every active reservation must be represented exactly once.
export function isCompleteRemoteSnapshot(snapshot, account) {
  if (snapshot?.ok !== true || snapshot.complete !== true || !Number.isSafeInteger(snapshot.total) || snapshot.total < 0
    || !Array.isArray(snapshot.reservations)) return false;
  if (snapshot.pixivUserId !== undefined && snapshot.pixivUserId !== null
    && String(snapshot.pixivUserId) !== String(account?.pixivUserId || '')) return false;
  const ids = new Set();
  for (const record of snapshot.reservations) {
    const id = record?.remoteId || record?.id;
    if (!record || typeof record !== 'object' || Array.isArray(record) || typeof record.status !== 'string' || !record.status.trim()) return false;
    // Explicitly not-uploaded attempts may only have their idempotency key;
    // they consume no remote slot. Active/unknown records require a remote ID.
    const identity = typeof id === 'string' && id.trim() ? 'remote:' + id
      : ['failed', 'cancelled'].includes(record.status) && typeof record.idempotencyKey === 'string' && record.idempotencyKey.trim()
        ? 'attempt:' + record.idempotencyKey : null;
    if (!identity || ids.has(identity)) return false;
    if (record.accountId && record.accountId !== account.id) return false;
    if (record.pixivUserId && String(record.pixivUserId) !== String(account.pixivUserId || '')) return false;
    ids.add(identity);
  }
  return snapshot.total === snapshot.reservations.filter(record => record.status === 'reserved').length;
}

/** Validate a complete job; drafts can be stored without passing this gate. */
export function validateJob(job, { now, requireSchedule = true } = {}) {
  const errors = [];
  const error = (field, code, message) => errors.push({ field, code, message });
  if (!job || typeof job !== 'object') return { valid: false, errors: [{ field: 'job', code: 'invalid_job', message: '作品数据无效。' }] };
  if (typeof job.id !== 'string' || !job.id.trim()) error('id', 'missing_id', '作品缺少唯一标识。');
  if (typeof job.accountId !== 'string' || !job.accountId.trim()) error('accountId', 'missing_account', '请选择投稿账号。');
  if (typeof job.title !== 'string' || job.title.length > 32) error('title', 'invalid_title', '标题最多 32 字，也可以留空。');
  if (!Array.isArray(job.files) || job.files.length === 0 || job.files.some(file => !file || (typeof file !== 'string' && !file.id && !file.url && !file.name))) {
    error('files', 'missing_files', '请添加有效的作品文件。');
  } else {
    if (job.files.length > 200) error('files', 'too_many_files', '每件作品最多 200 张图片。');
    if (job.files.some(file => Number.isFinite(file.size) && file.size > 32 * 1024 * 1024)) error('files', 'file_too_large', '每张图片不能超过 32 MB。');
    if (job.files.reduce((total, file) => total + (Number.isFinite(file.size) ? file.size : 0), 0) > 200 * 1024 * 1024) error('files', 'files_total_too_large', '每件作品的图片总大小不能超过 200 MB。');
  }
  if (!Array.isArray(job.tags) || job.tags.length < 1 || job.tags.length > 10 || job.tags.some(tag => typeof tag !== 'string' || !tag.trim())) {
    error('tags', 'invalid_tags', '请填写 1–10 个有效标签。');
  } else if (new Set(job.tags.map(tag => tag.trim().toLocaleLowerCase())).size !== job.tags.length) {
    error('tags', 'duplicate_tags', '标签不能重复。');
  }
  if (job.tagsConfirmed !== true) error('tagsConfirmed', 'tags_unconfirmed', '请确认作品标签后再加入预约队列。');
  if (job.status !== undefined && !JOB_STATUSES.includes(job.status)) error('status', 'invalid_status', '作品状态无效。');
  if (job.reservationAttempt !== undefined && (!Number.isSafeInteger(job.reservationAttempt) || job.reservationAttempt < 1)) error('reservationAttempt', 'invalid_attempt', '预约尝试编号无效。');

  const content = job.content;
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    error('content', 'missing_content', '请填写投稿选项并确认作品分级与 AI 标识。');
  } else {
    if (!['illust', 'manga'].includes(content.type)) error('content.type', 'invalid_type', '请选择插画或漫画。');
    if (typeof content.aiGenerated !== 'boolean') error('content.aiGenerated', 'ai_unconfirmed', '请确认是否为 AI 生成作品。');
    if (!['all', 'r18', 'r18g'].includes(content.rating)) error('content.rating', 'rating_unconfirmed', '请选择作品分级。');
    if (content.rating === 'all' && typeof content.sexualContent !== 'boolean') error('content.sexualContent', 'sexual_content_unconfirmed', '全年龄作品需要确认是否含有轻度性描写。');
    if (!['public', 'logged_in', 'mypixiv', 'private'].includes(content.visibility)) error('content.visibility', 'invalid_visibility', '请选择有效的公开范围。');
    if (content.seriesId && content.type !== 'manga') error('content.seriesId', 'series_requires_manga', '只有漫画可以关联系列。');
    if (content.thumbnail && (!Number.isInteger(content.thumbnail.page) || content.thumbnail.page < 1 || content.thumbnail.page > (Array.isArray(job.files) ? job.files.length : 0))) {
      error('content.thumbnail.page', 'thumbnail_page_out_of_range', '缩略图页码必须对应当前作品中实际存在的图片。');
    }
    if (requireSchedule && content.imageResponse) error('content.imageResponse', 'response_cannot_schedule', '图片回应不能使用预约投稿。');
    if (content.poll?.question || (Array.isArray(content.poll?.answers) && content.poll.answers.some(answer => answer))) {
      if (typeof content.poll.question !== 'string' || !content.poll.question.trim() || [...content.poll.question].length > 140) {
        error('content.poll.question', 'invalid_poll_question', '投票问题需为 1–140 个字符。');
      }
      if (!Array.isArray(content.poll.answers) || content.poll.answers.length < 2 || content.poll.answers.length > 5 || content.poll.answers.some(answer => typeof answer !== 'string' || !answer.trim() || [...answer].length > 20)) {
        error('content.poll.answers', 'invalid_poll_answers', '请填写 2–5 个投票选项，每项不超过 20 个字符。');
      }
    }
  }

  if (requireSchedule) {
    const scheduled = instant(job.scheduledAt);
    if (!Number.isFinite(scheduled)) error('scheduledAt', 'invalid_schedule', '预约时间必须包含 UTC 或时区偏移。');
    if (!validTimezone(job.timezone)) error('timezone', 'invalid_timezone', '请选择有效的 IANA 时区。');
    if (Number.isFinite(scheduled) && validTimezone(job.timezone)) {
      const localMinute = Number(new Intl.DateTimeFormat('en', { timeZone: PIXIV_TIMEZONE, minute: '2-digit' }).format(scheduled));
      if ((localMinute !== 0 && localMinute !== 30) || scheduled % 60000 !== 0) {
        error('scheduledAt', 'schedule_granularity', '预约时间换算为 Pixiv 日本时间后，必须为整点或半点。');
      }
      if (now !== undefined && scheduled <= clock(now)) error('scheduledAt', 'schedule_expired', '预约时间已到，请手动重新安排。');
    }
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Returns a deterministic, read-only plan. Slots include remote reservations
 * outside this app and all uncertain local uploads not visible in the snapshot.
 */
export function planReservations(state, now) {
  const time = clock(now);
  const actions = [];
  const reasons = [];
  const jobs = list(state, 'jobs');
  const accounts = list(state, 'accounts');
  const reason = (code, message, accountId, jobId) => reasons.push({ code, message, ...(accountId ? { accountId } : {}), ...(jobId ? { jobId } : {}) });
  if (state?.settings?.queuePaused) {
    reason('queue_paused', '所有账号的预约队列已暂停。');
    return { actions, reasons };
  }
  const duplicates = new Set(jobs.filter((job, index) => jobs.findIndex(other => other.id === job.id) !== index).map(job => job.id));
  const accountIds = new Set(accounts.map(account => account.id));
  for (const job of jobs) {
    if (job.status === 'queued' && !accountIds.has(job.accountId)) reason('account_missing', '投稿账号不存在。', job.accountId, job.id);
  }
  for (const account of accounts) {
    const ownJobs = jobs.filter(job => job.accountId === account.id);
    if (!ownJobs.some(job => job.status === 'queued')) continue;
    if (accounts.filter(other => other.id === account.id).length !== 1) { reason('duplicate_account', '账号标识重复，需人工检查。', account.id); continue; }
    if (account.pixivUserId && accounts.filter(other => String(other.pixivUserId || '') === String(account.pixivUserId)).length !== 1) {
      reason('duplicate_pixiv_account', '同一 Pixiv 账号存在重复资料，需合并后再预约。', account.id); continue;
    }
    if (account.connected !== true) { reason('account_disconnected', '账号尚未连接。', account.id); continue; }
    if (account.paused) { reason('account_paused', '账号队列已暂停。', account.id); continue; }
    if (account.premium !== true) { reason('premium_required', '预约投稿需要已确认的 Pixiv Premium 账号。', account.id); continue; }
    const remote = account.remote;
    const syncedAt = instant(remote?.syncedAt);
    if (!isCompleteRemoteSnapshot({ ...remote, ok: remote?.syncOk }, account)) {
      reason('sync_required', '需要成功同步远端预约后才能派发。', account.id); continue;
    }
    if (!Number.isFinite(syncedAt) || syncedAt > time || time - syncedAt > SNAPSHOT_MAX_AGE_MS) {
      reason('snapshot_stale', '远端预约快照已过期，请先重新同步。', account.id); continue;
    }
    const records = remote.reservations;
    const localHolds = ownJobs.filter(job => ['uploading', 'reserved', 'needs_review'].includes(job.status)
      && !(job.status === 'needs_review' && job.reviewReason === 'schedule_expired')
      && !records.some(record => record.status === 'reserved' && matches(job, record))).length;
    let available = Math.max(0, RESERVATION_LIMIT - Math.max(remote.total, records.filter(record => record.status === 'reserved').length) - localHolds);
    const ordered = ownJobs.filter(job => job.status === 'queued').sort((a, b) => (instant(a.scheduledAt) || Infinity) - (instant(b.scheduledAt) || Infinity) || String(a.id).localeCompare(String(b.id)));
    for (const job of ordered) {
      if (duplicates.has(job.id)) { reason('duplicate_job', '作品标识重复，需人工检查。', account.id, job.id); continue; }
      if (records.some(record => matches(job, record))) { reason('remote_exists', '远端已有此作品的结果，请先核对状态。', account.id, job.id); continue; }
      const validation = validateJob(job, { now, requireSchedule: true });
      if (!validation.valid) {
        for (const issue of validation.errors) reason(issue.code, issue.message, account.id, job.id);
        continue;
      }
      if (instant(job.scheduledAt) - time > RESERVATION_WINDOW_MS) { reason('outside_window', '尚未进入 Pixiv 的 7 天预约窗口，继续在本机排队。', account.id, job.id); continue; }
      if (available === 0) { reason('capacity_full', '该账号的预约名额已用完，等待远端释放。', account.id, job.id); continue; }
      actions.push({ type: 'reserve', accountId: account.id, jobId: job.id, scheduledAt: new Date(instant(job.scheduledAt)).toISOString(), idempotencyKey: reservationKey(job) });
      available -= 1;
    }
  }
  return { actions, reasons };
}

/**
 * snapshot.ok is explicit: failed syncs prohibit new uploads. `total` must count
 * every active remote reservation, including work created outside this app.
 * `complete` only means the list is exhaustive, never that absence proves publication.
 */
export function reconcileRemote(state, accountId, snapshot, now) {
  const time = clock(now);
  const next = structuredClone(state);
  const account = list(next, 'accounts').find(item => item.id === accountId);
  if (!account) return next;
  const records = Array.isArray(snapshot?.reservations) ? snapshot.reservations : [];
  const reservedCount = records.filter(record => record?.status === 'reserved').length;
  const successful = snapshot?.ok === true && Array.isArray(snapshot.reservations) && Number.isSafeInteger(snapshot.total) && snapshot.total >= reservedCount
    && records.every(record => record && typeof record === 'object' && !Array.isArray(record))
    && (snapshot.pixivUserId === undefined || snapshot.pixivUserId === null || String(snapshot.pixivUserId) === String(account.pixivUserId || ''));
  // Never infer historical ownership from the local account's current binding.
  // Native Chrome snapshots report the identity they have just verified; older
  // external connectors without that identity remain usable but cannot teach
  // account-specific posting templates.
  const verifiedPixivUserId = successful && /^\d{1,30}$/.test(String(snapshot.pixivUserId || ''))
    && String(snapshot.pixivUserId) === String(account.pixivUserId || '') ? String(snapshot.pixivUserId) : null;
  if (!successful) {
    account.remote = { ...account.remote, syncOk: false, lastSyncAttemptAt: new Date(time).toISOString(), error: String(snapshot?.error || '远端同步失败或快照不完整。') };
  } else {
    account.remote = { syncOk: true, syncedAt: new Date(time).toISOString(), total: snapshot.total, reservations: structuredClone(records), complete: snapshot.complete === true };
  }
  for (const job of list(next, 'jobs').filter(item => item.accountId === accountId)) {
    // A check is explanatory metadata only. Only a separately verified remote
    // publication record below can move a job into the published list.
    if (verifiedPixivUserId && snapshot.complete === true && ['reserved', 'needs_review', 'uploading'].includes(job.status) && job.remoteId) {
      const checks = list(snapshot, 'publicationChecks').filter(check => check?.jobId === job.id && check.remoteId === job.remoteId);
      if (checks.length === 1) {
        const check = checks[0], checkedAt = instant(check.checkedAt);
        if (check.status === 'pending' && /^[a-z_]{1,64}$/.test(check.reason || '') && Number.isFinite(checkedAt)
          && checkedAt <= time && (!Number.isFinite(instant(job.publicationCheck?.checkedAt)) || checkedAt >= instant(job.publicationCheck.checkedAt))) {
          job.publicationCheck = { jobId: job.id, remoteId: job.remoteId, status: 'pending', reason: check.reason, checkedAt: new Date(checkedAt).toISOString() };
        }
      }
    }
    const found = successful ? records.filter(record => matches(job, record)) : [];
    if (found.length > 1) {
      job.status = 'needs_review'; job.reviewReason = 'multiple_remote_matches'; job.updatedAt = new Date(time).toISOString(); continue;
    }
    const record = found[0];
    if (record && !['draft', 'cancelled', 'published'].includes(job.status)) {
      if (['reserved', 'published'].includes(record.status)) {
        const remoteTime = instant(record.scheduledAt), requestedTime = instant(job.scheduledAt);
        if (!Number.isFinite(remoteTime) || !Number.isFinite(requestedTime) || remoteTime !== requestedTime) {
          job.status = 'needs_review';
          job.reviewReason = Number.isFinite(remoteTime) ? 'reservation_time_mismatch' : 'reservation_time_missing';
          job.remoteId = record.remoteId || record.id || job.remoteId;
          job.idempotencyKey = reservationKey(job);
          job.remoteScheduledAt = Number.isFinite(remoteTime) ? new Date(remoteTime).toISOString() : null;
          job.lastError = Number.isFinite(remoteTime) ? '远端预约时间与本地计划不一致，必须人工核对；不会重新上传。' : '远端没有回读有效的预约时间，必须人工核对；不会重新上传。';
          job.updatedAt = new Date(time).toISOString();
          continue;
        }
      }
      if (['reserved', 'published', 'failed', 'cancelled'].includes(record.status)) {
        job.status = record.status;
        job.remoteId = record.remoteId || record.id || job.remoteId;
        job.idempotencyKey = reservationKey(job);
        job.updatedAt = new Date(time).toISOString();
        if (['reserved', 'published'].includes(record.status)) {
          job.remoteScheduledAt = new Date(instant(record.scheduledAt)).toISOString();
          // Only the confirmed publication receives learning provenance. If we
          // stamped it at reservation time, a later identity-less legacy
          // snapshot could incorrectly turn that reservation into learnable data.
          if (record.status === 'published' && verifiedPixivUserId && (!job.pixivUserId || String(job.pixivUserId) === verifiedPixivUserId)
            && (!record.pixivUserId || String(record.pixivUserId) === verifiedPixivUserId)) {
            job.pixivUserId = verifiedPixivUserId;
            if (/^\d{1,30}$/.test(String(record.artworkId || ''))) job.artworkId = String(record.artworkId);
          }
          delete job.lastError; delete job.error; delete job.uploadOutcome;
          delete job.publicationCheck;
        }
        delete job.reviewReason;
        if (record.status === 'published') {
          job.publishedAt = record.publishedAt || new Date(time).toISOString();
          if (verifiedPixivUserId && Number.isFinite(instant(record.publicationVerifiedAt)) && instant(record.publicationVerifiedAt) <= time) job.publicationVerifiedAt = new Date(instant(record.publicationVerifiedAt)).toISOString();
        }
        if (record.status === 'failed') job.error = record.error || '远端已明确返回投稿失败，请检查后手动处理。';
      } else {
        job.status = 'needs_review'; job.reviewReason = 'unknown_remote_status'; job.updatedAt = new Date(time).toISOString();
      }
      continue;
    }
    if (job.status === 'uploading') {
      const started = instant(job.uploadStartedAt || job.lastAttemptAt);
      if (!Number.isFinite(started) || time - started >= UPLOAD_TIMEOUT_MS) {
        job.status = 'needs_review'; job.reviewReason = 'upload_outcome_unknown'; job.updatedAt = new Date(time).toISOString();
      }
    } else if (successful && snapshot.complete === true && job.status === 'reserved') {
      job.status = 'needs_review'; job.reviewReason = 'reservation_missing_remotely'; job.updatedAt = new Date(time).toISOString();
    } else if (job.status === 'queued' && Number.isFinite(instant(job.scheduledAt)) && instant(job.scheduledAt) <= time) {
      job.status = 'needs_review'; job.reviewReason = 'schedule_expired'; job.updatedAt = new Date(time).toISOString();
    }
  }
  return next;
}
