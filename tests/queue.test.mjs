import test from 'node:test';
import assert from 'node:assert/strict';
import { planReservations, reconcileRemote as reconcileSnapshot, validateJob, SNAPSHOT_MAX_AGE_MS, UPLOAD_TIMEOUT_MS } from '../server/queue.mjs';

const NOW = '2026-10-04T00:00:00.000Z';
const account = (id = 'a', overrides = {}) => ({ id, connected: true, paused: false, premium: true, ...overrides,
  remote: { syncOk: true, complete: true, syncedAt: NOW, total: 0, reservations: [], ...overrides.remote } });
const reconcileRemote = (state, id, snapshot, now) => reconcileSnapshot(state, id, { complete: true, ...snapshot }, now);
const job = (id = 'j1', overrides = {}) => ({ id, accountId: 'a', title: '作品', tags: ['オリジナル'], tagsConfirmed: true, files: [{ id: 'image', name: 'image.png', size: 1 }], content: { type: 'illust', aiGenerated: false, rating: 'all', sexualContent: false, visibility: 'public' }, timezone: 'Asia/Shanghai', scheduledAt: '2026-10-05T00:00:00Z', status: 'queued', ...overrides });
const state = (jobs = [job()], accounts = [account()]) => ({ accounts, jobs, settings: { keep: true }, logs: [] });
const reserve = (current, actions) => ({ ...current, jobs: current.jobs.map(item => { const action = actions.find(value => value.jobId === item.id); return action ? { ...item, status: 'uploading', idempotencyKey: action.idempotencyKey, uploadStartedAt: NOW } : item; }) });

test('publication diagnostics require matching verified identity and cannot establish publication', () => {
  const current = state([job('review', { status: 'needs_review', reviewReason: 'reservation_missing_remotely', remoteId: 'illust:55' })], [account('a', { pixivUserId: '101' })]);
  const check = { jobId: 'review', remoteId: 'illust:55', status: 'pending', reason: 'ambiguous_match', checkedAt: NOW, secret: 'discard' };
  const snapshot = { ok: true, complete: true, total: 0, reservations: [], pixivUserId: '101', publicationChecks: [check] };
  const updated = reconcileRemote(current, 'a', snapshot, NOW);
  assert.equal(updated.jobs[0].status, 'needs_review');
  assert.deepEqual(updated.jobs[0].publicationCheck, { jobId: 'review', remoteId: 'illust:55', status: 'pending', reason: 'ambiguous_match', checkedAt: NOW });
  for (const changes of [{ pixivUserId: 'other' }, { pixivUserId: undefined }, { complete: false }, { ok: false },
    { publicationChecks: [check, check] }, { publicationChecks: [{ ...check, remoteId: 'illust:other' }] },
    { publicationChecks: [{ ...check, checkedAt: '2026-10-05T00:00:00Z' }] }, { publicationChecks: [{ ...check, status: 'published', artworkId: '200' }] }]) {
    const result = reconcileRemote(current, 'a', { ...snapshot, ...changes }, NOW);
    assert.equal(result.jobs[0].publicationCheck, undefined); assert.equal(result.jobs[0].status, 'needs_review');
  }
  const stale = reconcileRemote(updated, 'a', { ...snapshot, publicationChecks: [{ ...check, reason: 'candidate_read_failed', checkedAt: '2026-10-03T00:00:00Z' }] }, NOW);
  assert.deepEqual(stale.jobs[0].publicationCheck, updated.jobs[0].publicationCheck);
});

test('verified publication clears pending diagnostics and retains the actual verification time', () => {
  const check = { status: 'pending', reason: 'ambiguous_match', checkedAt: NOW };
  const current = state([job('review', { status: 'needs_review', remoteId: 'illust:55', scheduledAt: NOW, publicationCheck: check })], [account('a', { pixivUserId: '101' })]);
  const result = reconcileRemote(current, 'a', { ok: true, total: 0, complete: true, pixivUserId: '101', reservations: [{ remoteId: 'illust:55', jobId: 'review',
    status: 'published', scheduledAt: NOW, artworkId: '200', pixivUserId: '101', publishedAt: NOW, publicationVerifiedAt: NOW }] }, NOW);
  assert.equal(result.jobs[0].status, 'published'); assert.equal(result.jobs[0].artworkId, '200');
  assert.equal(result.jobs[0].publicationCheck, undefined); assert.equal(result.jobs[0].publicationVerifiedAt, NOW);
});

test('30 works roll through three confirmed batches of ten', () => {
  const jobs = Array.from({ length: 30 }, (_, index) => job(`j${String(index).padStart(2, '0')}`, { scheduledAt: `2026-10-0${5 + Math.floor(index / 10)}T00:00:00Z` }));
  let current = state(jobs);
  for (let day = 4; day < 7; day += 1) {
    const now = `2026-10-0${day}T00:00:00Z`;
    current = reconcileRemote(current, 'a', { ok: true, total: 0, complete: true, reservations: current.jobs.filter(item => item.status === 'reserved').map(item => ({ jobId: item.id, id: `remote-${item.id}`, scheduledAt: item.scheduledAt, status: 'published' })) }, now);
    const planned = planReservations(current, now);
    assert.equal(planned.actions.length, 10);
    assert.deepEqual(planned.actions.map(action => action.jobId), jobs.slice((day - 4) * 10, (day - 3) * 10).map(item => item.id));
    current = reserve(current, planned.actions);
    current = reconcileRemote(current, 'a', { ok: true, total: 10, complete: true, reservations: planned.actions.map(action => ({ ...action, id: `remote-${action.jobId}`, status: 'reserved' })) }, now);
    assert.equal(planReservations(current, now).actions.length, 0);
  }
  assert.equal(current.jobs.filter(item => item.status === 'published').length, 20);
  assert.equal(current.jobs.filter(item => item.status === 'reserved').length, 10);
});

test('eleventh work waits and uploading holds cannot be dispatched again', () => {
  const current = state(Array.from({ length: 11 }, (_, i) => job(`j${i}`)));
  const before = structuredClone(current);
  const planned = planReservations(current, NOW);
  assert.equal(planned.actions.length, 10);
  assert.equal(planned.reasons.filter(reason => reason.code === 'capacity_full').length, 1);
  assert.deepEqual(current, before);
  assert.deepEqual(planReservations(current, NOW).actions, planned.actions);
  assert.equal(planReservations(reserve(current, planned.actions), NOW).actions.length, 0);
});

test('capacity is isolated per account and includes external reservations', () => {
  const current = state([job('a1'), job('a2'), job('b1', { accountId: 'b' })], [account('a', { remote: { syncOk: true, syncedAt: NOW, total: 9,
    reservations: Array.from({ length: 9 }, (_, i) => ({ id: 'external-' + i, status: 'reserved' })) } }), account('b')]);
  const planned = planReservations(current, NOW);
  assert.deepEqual(planned.actions.map(action => action.jobId), ['a1', 'b1']);
});

test('paused, disconnected, non-Premium, failed and stale snapshots cannot dispatch', () => {
  for (const overrides of [{ paused: true }, { connected: false }, { premium: false }, { remote: { syncOk: false } }, { remote: { syncOk: true, syncedAt: new Date(Date.parse(NOW) - SNAPSHOT_MAX_AGE_MS - 1).toISOString(), total: 0, reservations: [] } }]) {
    assert.equal(planReservations(state([job()], [account('a', overrides)]), NOW).actions.length, 0);
  }
  assert.equal(planReservations({ ...state(), settings: { queuePaused: true } }, NOW).actions.length, 0);
});

test('tag confirmation and drafts are gates, jobs sort by schedule', () => {
  const current = state([job('later', { scheduledAt: '2026-10-06T00:00:00Z' }), job('draft', { status: 'draft' }), job('unconfirmed', { tagsConfirmed: false }), job('first')]);
  assert.deepEqual(planReservations(current, NOW).actions.map(action => action.jobId), ['first', 'later']);
});

test('window boundary is inclusive, far-future work stays local, expired work needs review', () => {
  const current = state([job('boundary', { scheduledAt: '2026-10-11T00:00:00Z' }), job('future', { scheduledAt: '2026-10-11T00:30:00Z' }), job('past', { scheduledAt: NOW })]);
  assert.deepEqual(planReservations(current, NOW).actions.map(action => action.jobId), ['boundary']);
  assert.ok(planReservations(current, NOW).reasons.some(reason => reason.code === 'outside_window'));
  const updated = reconcileRemote(current, 'a', { ok: true, total: 0, reservations: [], complete: true }, NOW);
  assert.equal(updated.jobs.find(item => item.id === 'past').status, 'needs_review');
  const oldQueue = state([...Array.from({ length: 10 }, (_, index) => job(`past${index}`, { scheduledAt: NOW })), job('next')]);
  const reconciled = reconcileRemote(oldQueue, 'a', { ok: true, total: 0, reservations: [], complete: true }, NOW);
  assert.equal(planReservations(reconciled, NOW).actions.length, 1);
});

test('absolute instants disambiguate DST; half-hour slots are always checked in Pixiv JST', () => {
  for (const scheduledAt of ['2026-11-01T01:30:00-04:00', '2026-11-01T01:30:00-05:00']) {
    assert.equal(validateJob(job('dst', { timezone: 'America/New_York', scheduledAt }), { now: '2026-10-31T00:00:00Z' }).valid, true);
  }
  assert.equal(validateJob(job('quarter', { timezone: 'Asia/Kathmandu', scheduledAt: '2026-10-05T00:15:00Z' }), { now: NOW }).valid, false);
  assert.equal(validateJob(job('jst', { timezone: 'Asia/Kathmandu', scheduledAt: '2026-10-05T00:30:00Z' }), { now: NOW }).valid, true);
  for (const overrides of [{ scheduledAt: '2026-10-05T00:15:00Z' }, { scheduledAt: '2026-10-05T00:30:01Z' }, { scheduledAt: '2026-10-05T00:30:00' }, { scheduledAt: '2026-02-30T00:30:00Z' }, { timezone: 'Imaginary/City' }]) {
    assert.equal(validateJob(job('bad', overrides), { now: NOW }).valid, false);
  }
});

test('passed reservation time never proves publication; missing or unknown records require review', () => {
  const past = job('reserved', { status: 'reserved', scheduledAt: '2026-10-03T00:00:00Z', remoteId: 'remote1' });
  const current = state([past]);
  const updated = reconcileRemote(current, 'a', { ok: true, total: 0, complete: true, reservations: [] }, NOW);
  assert.equal(updated.jobs[0].status, 'needs_review');
  assert.equal(updated.jobs[0].publishedAt, undefined);
  assert.equal(current.jobs[0].status, 'reserved');
  assert.deepEqual(updated.settings, current.settings);
  const unknown = reconcileRemote(current, 'a', { ok: true, total: 1, reservations: [{ id: 'remote1', status: 'mystery' }] }, NOW);
  assert.equal(unknown.jobs[0].reviewReason, 'unknown_remote_status');
  const published = reconcileRemote(updated, 'a', { ok: true, total: 0, reservations: [{ id: 'remote1', scheduledAt: past.scheduledAt, status: 'published' }] }, NOW);
  assert.equal(published.jobs[0].status, 'published');
});

test('upload timeout is uncertain and never automatically retried, even during sync failure', () => {
  const current = state([job('upload', { status: 'uploading', uploadStartedAt: new Date(Date.parse(NOW) - UPLOAD_TIMEOUT_MS).toISOString() }), job('next')]);
  const updated = reconcileRemote(current, 'a', { ok: false, error: 'offline' }, NOW);
  assert.equal(updated.jobs[0].status, 'needs_review');
  assert.equal(updated.accounts[0].remote.syncOk, false);
  assert.equal(planReservations(updated, NOW).actions.length, 0);
});

test('remote idempotency match prevents duplicate upload and duplicated remote matches require review', () => {
  const current = state();
  const action = planReservations(current, NOW).actions[0];
  current.accounts[0].remote.reservations = [{ id: 'known', idempotencyKey: action.idempotencyKey, status: 'reserved' }];
  current.accounts[0].remote.total = 1;
  assert.equal(planReservations(current, NOW).actions.length, 0);
  const updated = reconcileRemote(current, 'a', { ok: true, total: 2, reservations: [{ id: 'one', jobId: 'j1', status: 'reserved' }, { id: 'two', jobId: 'j1', status: 'reserved' }] }, NOW);
  assert.equal(updated.jobs[0].status, 'needs_review');
});

test('malformed totals fail closed and uncertain local reservations continue occupying slots', () => {
  const current = state([job('uncertain', { status: 'needs_review' }), ...Array.from({ length: 10 }, (_, i) => job(`next${i}`))]);
  assert.equal(planReservations(current, NOW).actions.length, 9);
  for (const total of [-1, undefined, 1.5]) {
    const updated = reconcileRemote(current, 'a', { ok: true, total, reservations: [] }, NOW);
    assert.equal(updated.accounts[0].remote.syncOk, false);
  }
});

test('dispatch requires an exhaustive unique reservation list and rejects an explicit wrong Pixiv identity', () => {
  const current = state(); current.accounts[0].pixivUserId = '101';
  for (const remote of [
    { complete: false }, { complete: undefined }, { total: 1 },
    { total: 2, reservations: [{ id: 'same', status: 'reserved' }, { id: 'same', status: 'reserved' }] },
    { total: 1, reservations: [{ status: 'reserved' }] },
  ]) {
    const candidate = structuredClone(current); Object.assign(candidate.accounts[0].remote, remote);
    assert.equal(planReservations(candidate, NOW).actions.length, 0);
  }
  const wrong = reconcileRemote(current, 'a', { ok: true, complete: true, total: 0, reservations: [], pixivUserId: '999' }, NOW);
  assert.equal(wrong.accounts[0].remote.syncOk, false); assert.equal(planReservations(wrong, NOW).actions.length, 0);
  const legacy = reconcileRemote(current, 'a', { ok: true, complete: true, total: 0, reservations: [] }, NOW);
  assert.equal(planReservations(legacy, NOW).actions.length, 1, 'Older external connectors may omit identity but must give a complete list.');
});

test('two in-flight local claims consume both remaining slots without double counting a newly visible claim', () => {
  const initial = state([job('first'), job('second'), job('third')]);
  initial.accounts[0].remote.reservations = Array.from({ length: 8 }, (_, i) => ({ id: 'outside-' + i, status: 'reserved' }));
  initial.accounts[0].remote.total = 8;
  const claims = planReservations(initial, NOW).actions;
  assert.equal(claims.length, 2);
  const claimed = reserve(initial, claims);
  assert.equal(planReservations(claimed, NOW).actions.length, 0);
  claimed.accounts[0].remote.reservations.push({ id: 'new', status: 'reserved', jobId: 'first', idempotencyKey: claims[0].idempotencyKey });
  claimed.accounts[0].remote.total = 9;
  assert.equal(planReservations(claimed, NOW).actions.length, 0);
});

test('duplicate local bindings of the same Pixiv identity cannot obtain independent ten-slot allowances', () => {
  const current = state([job('a1'), job('b1', { accountId: 'b' })], [account('a', { pixivUserId: '101' }), account('b', { pixivUserId: '101' })]);
  const plan = planReservations(current, NOW);
  assert.equal(plan.actions.length, 0);
  assert.ok(plan.reasons.every(reason => reason.code === 'duplicate_pixiv_account'));
});

test('post options require explicit AI, rating and all-age sexual-content choices', () => {
  const content = { type: 'illust', aiGenerated: false, rating: 'all', sexualContent: false, visibility: 'public', poll: { question: '', answers: [] } };
  assert.equal(validateJob(job('valid', { content }), { now: NOW }).valid, true);
  for (const extra of [{ aiGenerated: null }, { rating: null }, { sexualContent: null }, { seriesId: 'series' }, { imageResponse: '123' }, { poll: { question: '选择', answers: ['only one'] } }]) {
    assert.equal(validateJob(job('invalid', { content: { ...content, ...extra } }), { now: NOW }).valid, false);
  }
  assert.equal(validateJob(job('missing', { content: undefined }), { now: NOW }).valid, false);
  assert.equal(validateJob(job('adult', { content: { ...content, rating: 'r18', sexualContent: null } }), { now: NOW }).valid, true);
});

test('explicit failed-job retry uses a new idempotency attempt and ignores old remote history', () => {
  const current = state();
  const original = planReservations(current, NOW).actions[0];
  const retry = { ...current.jobs[0], reservationAttempt: 2 };
  const failedHistory = [{ remoteId: 'failed-remote', jobId: retry.id, idempotencyKey: original.idempotencyKey, status: 'failed' }];
  const retryState = reconcileRemote(state([retry]), 'a', { ok: true, total: 0, reservations: failedHistory }, NOW);
  const planned = planReservations(retryState, NOW);
  assert.equal(retryState.jobs[0].status, 'queued');
  assert.equal(planned.actions.length, 1);
  assert.notEqual(planned.actions[0].idempotencyKey, original.idempotencyKey);
  const reserved = reconcileRemote(reserve(retryState, planned.actions), 'a', { ok: true, total: 1, reservations: [...failedHistory, { jobId: retry.id, idempotencyKey: planned.actions[0].idempotencyKey, remoteId: 'retry-remote', scheduledAt: retry.scheduledAt, status: 'reserved' }] }, NOW);
  assert.equal(reserved.jobs[0].status, 'reserved');
  assert.equal(reserved.jobs[0].remoteId, 'retry-remote');
  assert.equal(planReservations(reserved, NOW).actions.length, 0);
});

test('delayed publication stays reserved until the connector explicitly confirms publication', () => {
  const current = state([job('delayed', { status: 'reserved', scheduledAt: '2026-10-03T23:30:00Z' })]);
  const delayed = reconcileRemote(current, 'a', { ok: true, total: 1, complete: true, reservations: [{ jobId: 'delayed', remoteId: 'remote-delayed', scheduledAt: current.jobs[0].scheduledAt, status: 'reserved' }] }, NOW);
  assert.equal(delayed.jobs[0].status, 'reserved');
  assert.equal(delayed.jobs[0].publishedAt, undefined);
});

test('200 image and 200 MB total limits are enforced before dispatch', () => {
  const files = Array.from({ length: 200 }, (_, index) => ({ id: `file-${index}`, size: 1024 * 1024 }));
  assert.equal(validateJob(job('boundary', { files }), { now: NOW }).valid, true);
  assert.equal(validateJob(job('count', { files: [...files, { id: 'overflow', size: 1 }] }), { now: NOW }).valid, false);
  assert.equal(validateJob(job('total', { files: files.map((file, index) => ({ ...file, size: file.size + (index === 0 ? 1 : 0) })) }), { now: NOW }).valid, false);
  assert.equal(validateJob(job('single', { files: [{ id: 'large', size: 32 * 1024 * 1024 + 1 }] }), { now: NOW }).valid, false);
});

test('thumbnail pages must reference a real image before dispatch', () => {
  const current = job();
  const valid = { ...current, content: { ...current.content, thumbnail: { page: 1, x: 0.5, y: 0.5 } } };
  assert.equal(validateJob(valid, { now: NOW }).valid, true);
  const invalid = { ...valid, content: { ...valid.content, thumbnail: { page: 2, x: 0.5, y: 0.5 } } };
  assert.ok(validateJob(invalid, { now: NOW }).errors.some(issue => issue.code === 'thumbnail_page_out_of_range'));
  assert.equal(planReservations(state([invalid]), NOW).actions.length, 0);
  assert.equal(validateJob({ ...invalid, files: [...invalid.files, { id: 'second', size: 1 }] }, { now: NOW }).valid, true);
});

test('remote success requires a matching absolute reservation time and uncertain time never enables reupload', () => {
  for (const status of ['reserved', 'published']) {
    for (const scheduledAt of [undefined, '2026-10-05T01:00:00Z', '2026-10-05T00:00:00']) {
      const current = state();
      const action = planReservations(current, NOW).actions[0];
      const snapshot = { ok: true, complete: true, total: status === 'reserved' ? 1 : 0,
        reservations: [{ jobId: 'j1', idempotencyKey: action.idempotencyKey, remoteId: 'actual-remote', status, scheduledAt }] };
      const updated = reconcileRemote(reserve(current, [action]), 'a', snapshot, NOW);
      assert.equal(updated.jobs[0].status, 'needs_review');
      assert.equal(updated.jobs[0].remoteId, 'actual-remote');
      assert.equal(updated.jobs[0].publishedAt, undefined);
      assert.match(updated.jobs[0].reviewReason, /^reservation_time_/);
      assert.equal(planReservations(updated, NOW).actions.length, 0);
      const corrected = reconcileRemote(updated, 'a', { ...snapshot, reservations: [{ ...snapshot.reservations[0], scheduledAt: '2026-10-05T09:00:00+09:00' }] }, NOW);
      assert.equal(corrected.jobs[0].status, status, 'Equivalent UTC/JST instants should match.');
      assert.equal(corrected.jobs[0].lastError, undefined);
    }
  }
});

test('verified publication records Pixiv ownership and the final artwork ID for history learning', () => {
  const original = state([job('learning', { status: 'uploading' })], [account('a', { pixivUserId: '123' })]);
  const record = { jobId: 'learning', remoteId: 'illust:55', scheduledAt: original.jobs[0].scheduledAt, status: 'reserved' };
  const reserved = reconcileRemote(original, 'a', { ok: true, connected: true, complete: true, pixivUserId: '123', total: 1, reservations: [record] }, NOW);
  assert.equal(reserved.jobs[0].status, 'reserved');
  assert.equal(reserved.jobs[0].pixivUserId, undefined, 'reservation alone does not establish publication provenance');
  assert.equal(reserved.jobs[0].artworkId, undefined);
  const publishedAt = '2026-10-05T00:00:00.000Z';
  const published = reconcileRemote(reserved, 'a', { ok: true, connected: true, complete: true, pixivUserId: '123', total: 0,
    reservations: [{ ...record, status: 'published', artworkId: '998877', publishedAt }] }, publishedAt);
  assert.equal(published.jobs[0].status, 'published');
  assert.equal(published.jobs[0].pixivUserId, '123');
  assert.equal(published.jobs[0].artworkId, '998877');
  assert.equal(published.jobs[0].publishedAt, publishedAt);
  assert.equal(published.jobs[0].tagsConfirmed, true);
  assert.deepEqual(published.jobs[0].tags, original.jobs[0].tags);
  assert.equal(original.jobs[0].pixivUserId, undefined, 'reconciliation remains immutable');
  const legacy = reconcileRemote(reserved, 'a', { ok: true, total: 0,
    reservations: [{ ...record, status: 'published', artworkId: '998877', publishedAt }] }, publishedAt);
  assert.equal(legacy.jobs[0].pixivUserId, undefined, 'a formerly verified reservation still needs publication identity');
  assert.equal(legacy.jobs[0].artworkId, undefined);
});

test('missing or mismatched remote identity never stamps an account binding or artwork into learned history', () => {
  for (const pixivUserId of [undefined, '', '456']) {
    const current = state([job('unverified', { status: 'reserved', remoteId: 'illust:55' })], [account('a', { pixivUserId: '123' })]);
    const updated = reconcileRemote(current, 'a', { ok: true, total: 0, pixivUserId,
      reservations: [{ remoteId: 'illust:55', scheduledAt: current.jobs[0].scheduledAt, status: 'published', artworkId: '998877' }] }, NOW);
    assert.equal(updated.jobs[0].pixivUserId, undefined);
    assert.equal(updated.jobs[0].artworkId, undefined);
  }
  for (const overrides of [{ pixivUserId: '456' }, { recordPixivUserId: '456' }]) {
    const current = state([job('rebound', { status: 'reserved', remoteId: 'illust:55', ...(overrides.pixivUserId ? { pixivUserId: overrides.pixivUserId } : {}) })], [account('a', { pixivUserId: '123' })]);
    const updated = reconcileRemote(current, 'a', { ok: true, total: 0, pixivUserId: '123',
      reservations: [{ remoteId: 'illust:55', scheduledAt: current.jobs[0].scheduledAt, status: 'published', artworkId: '998877', pixivUserId: overrides.recordPixivUserId }] }, NOW);
    assert.equal(updated.jobs[0].pixivUserId, current.jobs[0].pixivUserId, 'an older binding must not be overwritten');
    assert.equal(updated.jobs[0].artworkId, undefined);
  }
});

test('already published records and unresolved time conflicts are not retroactively assigned the current identity', () => {
  for (const [status, remoteTime] of [['published', '2026-10-05T00:00:00Z'], ['reserved', '2026-10-05T01:00:00Z']]) {
    const current = state([job('old', { status, remoteId: 'illust:55' })], [account('a', { pixivUserId: '123' })]);
    const updated = reconcileRemote(current, 'a', { ok: true, total: 0, pixivUserId: '123',
      reservations: [{ remoteId: 'illust:55', scheduledAt: remoteTime, status: 'published', artworkId: '998877' }] }, NOW);
    assert.equal(updated.jobs[0].pixivUserId, undefined);
    assert.equal(updated.jobs[0].artworkId, undefined);
  }
});
