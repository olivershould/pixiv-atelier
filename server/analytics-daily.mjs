const DAY_MS = 86400000;
const OFFSET_MS = 8 * 3600000;
const METRICS = ['views', 'bookmarks', 'likes', 'followers'];
export const DAILY_FOLLOWER_SERIES = 'pixiv-followers-page-total-v1';
export const shanghaiDate = at => new Date(Date.parse(at) + OFFSET_MS).toISOString().slice(0, 10);
const dayAt = date => Date.parse(`${date}T00:00:00+08:00`);
const shiftDate = (date, count) => shanghaiDate(new Date(dayAt(date) + count * DAY_MS).toISOString());

function viewSourceKey(source) {
  const info = source?.viewCount;
  if (!info || typeof info !== 'object') return 'unknown';
  if (typeof info.seriesId === 'string' && info.seriesId) return `series:${info.seriesId}`;
  // Older observations predate the explicit surface label but already identify
  // the same cumulative access counter. Chart URL date ranges are not series.
  if (info.section === 'access' && (!info.scope || info.scope === 'cumulative')
    && (!info.surface || info.surface === 'report-top-summary')) return 'pixiv-report-cumulative-access';
  const fields = [info.surface || null, info.section || null, info.scope || null];
  return fields.some(Boolean) ? JSON.stringify(fields) : 'unknown';
}

export function dailyRange(timestamp, requestedDays) {
  const days = ['7', '30', '90', '365'].includes(String(requestedDays)) ? String(requestedDays) : '30';
  const today = shanghaiDate(timestamp), from = shiftDate(today, 1 - Number(days));
  return { days, today, from, queryFrom: new Date(dayAt(shiftDate(from, -1))).toISOString() };
}

/** Daily differences are between comparable observations, never filled-in days. */
export function buildAccountDaily({ timestamp, days, firstObservedAt, accountObservations = [], periodicObservations = [], works = [] }) {
  const range = dailyRange(timestamp, days);
  const firstDate = firstObservedAt ? shanghaiDate(firstObservedAt) : range.today;
  const from = firstDate > range.from ? firstDate > range.today ? range.today : firstDate : range.from;
  const points = Object.fromEntries(METRICS.map(metric => [metric, []]));
  for (const row of accountObservations) {
    let source;
    try { source = JSON.parse(row.source_json); } catch { source = {}; }
    const followersSupported = source?.followerCount?.seriesId === DAILY_FOLLOWER_SERIES;
    points.views.push({ value: row.views, at: row.observed_at, order: row.id, sourceKey: viewSourceKey(source), reason: row.views === null ? 'metric_missing' : null });
    points.followers.push({ value: followersSupported ? row.followers : null, at: row.observed_at, order: row.id,
      reason: !followersSupported ? 'unsupported_source' : row.followers === null ? 'metric_missing' : null });
  }
  for (const row of periodicObservations) for (const metric of ['bookmarks', 'likes']) {
    const complete = !row.invalid_reason && row.work_count > 0 && row[`${metric}_count`] === row.work_count;
    points[metric].push({ value: complete ? row[metric] : null, at: row.end_at, order: row.sample_order ?? row.id, snapshot: row,
      reason: complete ? null : row.invalid_reason || 'incomplete_snapshot' });
  }
  const byDay = {};
  for (const metric of METRICS) {
    const sorted = points[metric].filter(point => point.at <= timestamp).sort((a, b) => a.at.localeCompare(b.at) || a.order - b.order);
    const distinctTimes = [...new Map(sorted.map(point => [point.at, point])).values()];
    byDay[metric] = new Map();
    for (const point of distinctTimes) {
      const date = shanghaiDate(point.at);
      if (!byDay[metric].has(date)) byDay[metric].set(date, []);
      byDay[metric].get(date).push(point);
    }
  }
  function comparisonIssue(start, end) {
    if (start.sourceKey !== end.sourceKey) return 'source_changed';
    if (!start.snapshot || !end.snapshot || start.snapshot.scope_hash === end.snapshot.scope_hash) return null;
    const before = start.snapshot, after = end.snapshot, increase = after.work_count - before.work_count;
    if (increase <= 0) return 'scope_changed';
    const added = works.filter(work => work.first_seen > before.completed_at && work.first_seen <= after.completed_at);
    return added.length === increase && added.every(work => work.published_verified === 1 && work.published_at
      && work.published_at >= before.end_at && work.published_at <= after.end_at) ? null : 'scope_changed';
  }
  function measurement(metric, date) {
    const dates = byDay[metric], todayPoints = dates.get(date) || [], end = todayPoints.at(-1);
    const previous = (dates.get(shiftDate(date, -1)) || []).at(-1);
    const missing = (reason, start = null) => ({ delta: null, startValue: start?.value ?? null, endValue: end?.value ?? null,
      startAt: start?.at || null, endAt: end?.at || null, status: 'missing', reason });
    if (!end) return missing('no_observation');
    if (end.reason || end.value === null) return missing(end.reason || 'metric_missing', previous?.reason ? null : previous);
    let start, status, reason;
    if (previous && !previous.reason && previous.value !== null) {
      start = previous; status = 'complete';
    } else {
      const earlier = [...dates.entries()].some(([day, observations]) => day < date && observations.some(point => !point.reason && point.value !== null));
      if (earlier) return missing('previous_day_missing');
      const candidates = todayPoints.filter(point => !point.reason && point.value !== null && point.at < end.at);
      start = candidates.find(point => !comparisonIssue(point, end));
      if (!start) return candidates.length ? missing(comparisonIssue(candidates[0], end), candidates[0]) : missing('first_observation_only');
      status = 'partial'; reason = 'first_day_partial';
    }
    if (start.at >= end.at) return missing('invalid_interval', start);
    const issue = comparisonIssue(start, end);
    if (issue) return missing(issue, start);
    return { delta: end.value - start.value, startValue: start.value, endValue: end.value, startAt: start.at, endAt: end.at,
      status, ...(reason ? { reason } : {}) };
  }
  const rows = [];
  for (let date = range.today; date >= from; date = shiftDate(date, -1)) rows.push({ date, isToday: date === range.today,
    metrics: Object.fromEntries(METRICS.map(metric => [metric, measurement(metric, date)])) });
  return { timezone: 'Asia/Shanghai', days: range.days, range: { from, to: range.today }, today: rows[0], rows };
}
