import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { buildPostingTemplates } from './posting-templates.mjs';
import { knownCharacterGameFamilies } from './recognition.mjs';
import { knownManualCharacterTagIdentities } from './manual-character-tags.mjs';
import { normalizeArtworkThumbnail } from './artwork-thumbnail.mjs';
import { buildAccountDaily, dailyRange, DAILY_FOLLOWER_SERIES } from './analytics-daily.mjs';

export const ANALYTICS_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const ANALYTICS_MILESTONES = Object.freeze([
  { key: '6h', hours: 6 }, { key: '12h', hours: 12 },
  { key: '24h', hours: 24 }, { key: '7d', hours: 168 },
]);
export const ANALYTICS_MILESTONE_GRACE_MS = 30 * 60 * 1000;
const METRICS = ['views', 'bookmarks', 'likes'];
const bookmarkRate = metrics => metrics.views > 0 && metrics.bookmarks !== null ? metrics.bookmarks / metrics.views : null;
const normalize = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[\s_]/g, '');
const textList = values => [...new Set((Array.isArray(values) ? values : []).filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()))];
const number = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const iso = value => Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const parse = (value, fallback = []) => { try { return JSON.parse(value); } catch { return fallback; } };
const dateMax = values => values.filter(Boolean).sort().at(-1) || null;
const familyDefinitions = knownCharacterGameFamilies();
const gameKey = tags => [...new Set(textList(tags).map(tag => familyDefinitions.find(game => game.tags.some(name => normalize(name) === normalize(tag)))?.key || `custom:${normalize(tag)}`))].sort().join('|');

function characterList(values) {
  const result = new Map();
  for (const value of Array.isArray(values) ? values : []) {
    const name = typeof value === 'string' ? value : value?.englishName || value?.name;
    if (typeof name !== 'string' || !name.trim()) continue;
    const key = typeof value === 'object' && value.key ? String(value.key) : `${normalize(name)}:${gameKey(value?.gameTags)}`;
    if (!result.has(key)) result.set(key, { key, name: name.trim() });
  }
  return [...result.values()];
}

/** Reuse the posting-template identity rules. A title alone is not a character. */
export function inferAnalyticsCharacters(works, { characters = [], accountId = '' } = {}) {
  const inferred = new Map();
  const { templates } = buildPostingTemplates({ scope: { accountId, mode: 'live' }, evidence: { recentWorks: works }, characters });
  for (const template of templates) for (const id of template.sourceArtworkIds) inferred.set(String(id), characterList([template]));
  // Template composition intentionally rejects multi-character works. Analytics
  // can still attribute a work to each explicitly tagged, game-scoped identity.
  // A bare title or an ambiguous tag never establishes another role.
  const identities = new Map();
  for (const definition of [...knownManualCharacterTagIdentities(), ...characters]) {
    if (!definition.englishName || !definition.gameTags?.length || !definition.characterTags?.length) continue;
    const identity = characterList([definition])[0], previous = identities.get(identity.key);
    identities.set(identity.key, { identity,
      gameTags: new Set([...(previous?.gameTags || []), ...definition.gameTags.map(normalize)]),
      characterTags: new Set([...(previous?.characterTags || []), ...definition.characterTags.map(normalize)]) });
  }
  for (const work of works) {
    const tags = textList(work.tags).map(normalize);
    const scoped = [...identities.values()].filter(identity => tags.some(tag => identity.gameTags.has(tag)));
    const matched = new Map();
    for (const tag of tags) {
      const candidates = scoped.filter(identity => identity.characterTags.has(tag));
      if (candidates.length === 1) matched.set(candidates[0].identity.key, candidates[0].identity);
    }
    if (matched.size) inferred.set(String(work.artworkId), [...matched.values()]);
  }
  return inferred;
}

/**
 * Historical observations live in an indexed SQLite file, separate from UI state.
 * All times are actual observations; fixed-age samples have a bounded window.
 * The caller owns account authentication, request pacing, and persistent run IDs.
 */
export function createAnalyticsStore({ dataDir, filename, now = () => new Date(), milestoneGraceMs = ANALYTICS_MILESTONE_GRACE_MS } = {}) {
  if (!filename && !dataDir) throw new Error('Analytics dataDir is required');
  const databasePath = filename || path.join(dataDir, 'analytics.sqlite');
  if (databasePath !== ':memory:') mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  const graceMs = Number.isFinite(milestoneGraceMs) && milestoneGraceMs >= 0 ? milestoneGraceMs : ANALYTICS_MILESTONE_GRACE_MS;
  const clock = () => iso(now()) || new Date().toISOString();
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS works (
      account_id TEXT NOT NULL, artwork_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
      published_at TEXT, published_verified INTEGER NOT NULL DEFAULT 0, publication_provisional INTEGER NOT NULL DEFAULT 0, publication_source TEXT,
      tags_json TEXT NOT NULL DEFAULT '[]', characters_json TEXT NOT NULL DEFAULT '[]', thumbnail_url TEXT,
      first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
      PRIMARY KEY(account_id, artwork_id)
    );
    CREATE TABLE IF NOT EXISTS samples (
      id INTEGER PRIMARY KEY, account_id TEXT NOT NULL, artwork_id TEXT NOT NULL,
      observed_at TEXT NOT NULL, run_key TEXT NOT NULL, kind TEXT NOT NULL,
      views INTEGER, bookmarks INTEGER, likes INTEGER,
      UNIQUE(account_id, artwork_id, run_key),
      FOREIGN KEY(account_id, artwork_id) REFERENCES works(account_id, artwork_id)
    );
    CREATE INDEX IF NOT EXISTS sample_by_work_time ON samples(account_id, artwork_id, observed_at, id);
    CREATE INDEX IF NOT EXISTS sample_by_periodic_run ON samples(account_id,kind,run_key,observed_at,id);
    CREATE INDEX IF NOT EXISTS works_by_first_seen ON works(account_id,first_seen);
    CREATE TABLE IF NOT EXISTS milestones (
      account_id TEXT NOT NULL, artwork_id TEXT NOT NULL, point TEXT NOT NULL,
      target_at TEXT NOT NULL, window_end TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      sample_id INTEGER, lateness_ms INTEGER, reason TEXT,
      PRIMARY KEY(account_id, artwork_id, point),
      FOREIGN KEY(account_id, artwork_id) REFERENCES works(account_id, artwork_id),
      FOREIGN KEY(sample_id) REFERENCES samples(id)
    );
    CREATE INDEX IF NOT EXISTS milestone_due ON milestones(status, target_at, window_end);
    CREATE TABLE IF NOT EXISTS account_samples (
      id INTEGER PRIMARY KEY, account_id TEXT NOT NULL, observed_at TEXT NOT NULL,
      run_key TEXT NOT NULL, views INTEGER, followers INTEGER, source_json TEXT NOT NULL DEFAULT '{}',
      UNIQUE(account_id, run_key)
    );
    CREATE INDEX IF NOT EXISTS account_sample_time ON account_samples(account_id, observed_at, id);
    CREATE TABLE IF NOT EXISTS analytics_accounts (account_id TEXT PRIMARY KEY, enabled_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS analytics_meta (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS analytics_periodic_totals (
      id INTEGER PRIMARY KEY,account_id TEXT NOT NULL,run_key TEXT NOT NULL,
      start_at TEXT NOT NULL,end_at TEXT NOT NULL,completed_at TEXT NOT NULL,work_count INTEGER NOT NULL,
      views INTEGER,bookmarks INTEGER,likes INTEGER,views_count INTEGER NOT NULL,bookmarks_count INTEGER NOT NULL,likes_count INTEGER NOT NULL,
      scope_hash TEXT NOT NULL,origin TEXT NOT NULL,invalid_reason TEXT,sample_order INTEGER NOT NULL DEFAULT 0,UNIQUE(account_id,run_key)
    );
    CREATE INDEX IF NOT EXISTS periodic_totals_by_time ON analytics_periodic_totals(account_id,end_at,id);
    INSERT INTO analytics_accounts(account_id,enabled_at)
      SELECT account_id,MIN(observed_at) FROM (
        SELECT account_id,MIN(observed_at) observed_at FROM samples GROUP BY account_id
        UNION ALL SELECT account_id,MIN(observed_at) observed_at FROM account_samples GROUP BY account_id
      ) GROUP BY account_id ON CONFLICT(account_id) DO NOTHING;
  `);
  const workColumns = new Set(db.prepare('PRAGMA table_info(works)').all().map(column => column.name));
  if (!workColumns.has('published_verified')) db.exec('ALTER TABLE works ADD COLUMN published_verified INTEGER NOT NULL DEFAULT 0');
  if (!workColumns.has('publication_provisional')) {
    db.exec('ALTER TABLE works ADD COLUMN publication_provisional INTEGER NOT NULL DEFAULT 0');
    if (workColumns.has('publication_source')) db.exec(`UPDATE works SET publication_provisional=1
      WHERE published_verified=0 AND publication_source='pixiv-management-thumbnail'`);
  }
  if (!workColumns.has('publication_source')) db.exec('ALTER TABLE works ADD COLUMN publication_source TEXT');
  if (!workColumns.has('thumbnail_url')) db.exec('ALTER TABLE works ADD COLUMN thumbnail_url TEXT');
  if (!db.prepare('PRAGMA table_info(analytics_periodic_totals)').all().some(column => column.name === 'invalid_reason')) db.exec('ALTER TABLE analytics_periodic_totals ADD COLUMN invalid_reason TEXT');
  if (!db.prepare('PRAGMA table_info(analytics_periodic_totals)').all().some(column => column.name === 'sample_order')) {
    db.exec(`ALTER TABLE analytics_periodic_totals ADD COLUMN sample_order INTEGER NOT NULL DEFAULT 0;
      UPDATE analytics_periodic_totals SET sample_order=COALESCE((SELECT MAX(s.id) FROM samples s
        WHERE s.account_id=analytics_periodic_totals.account_id AND s.run_key=analytics_periodic_totals.run_key AND s.kind='periodic'),0)`);
  }
  db.exec(`UPDATE milestones SET status='pending',sample_id=NULL,lateness_ms=NULL,reason='publication_time_unverified'
    WHERE EXISTS(SELECT 1 FROM works w WHERE w.account_id=milestones.account_id AND w.artwork_id=milestones.artwork_id AND w.publication_provisional=1)`);
  const prepared = new Map();
  const sql = query => { if (!prepared.has(query)) prepared.set(query, db.prepare(query)); return prepared.get(query); };
  const transaction = fn => { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } };
  const accountKey = value => { if (typeof value !== 'string' || !value.trim()) throw new Error('Analytics accountId is required'); return value; };
  const scope = (accountId, accountIds, prefix = '') => {
    const conditions = [], args = [], column = `${prefix}account_id`;
    if (accountId && accountId !== 'all') { conditions.push(`${column}=?`); args.push(accountId); }
    if (Array.isArray(accountIds)) {
      const allowed = [...new Set(accountIds.filter(id => typeof id === 'string' && id))];
      conditions.push(allowed.length ? `${column} IN (${allowed.map(() => '?').join(',')})` : '0');
      args.push(...allowed);
    }
    return { where: conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '', args };
  };

  function upsertInternal(accountId, works, { observedAt, characters = [] } = {}) {
    accountKey(accountId);
    const timestamp = iso(observedAt) || clock();
    const valid = (Array.isArray(works) ? works : []).filter(work => work && work.artworkId != null && String(work.artworkId).trim());
    const inferred = inferAnalyticsCharacters(valid, { accountId, characters });
    for (const work of valid) {
      const id = String(work.artworkId), existing = sql('SELECT * FROM works WHERE account_id=? AND artwork_id=?').get(accountId, id);
      const title = typeof work.title === 'string' ? work.title : existing?.title || '';
      const incomingPublishedAt = iso(work.publishedAt || work.createDate);
      const protectVerifiedTime = existing?.published_verified === 1 && work.publicationTimeVerified !== true;
      const publishedAt = protectVerifiedTime ? existing.published_at : incomingPublishedAt || existing?.published_at || null;
      const publishedVerified = protectVerifiedTime ? 1 : incomingPublishedAt ? work.publicationTimeVerified === true ? 1 : 0 : existing?.published_verified || 0;
      const publicationProvisional = publishedVerified ? 0 : work.publicationTimeVerified === false ? 1 : existing?.publication_provisional || 0;
      const publicationSource = protectVerifiedTime || !incomingPublishedAt ? existing?.publication_source || null
        : work.createDateSource || work.publicationTimeSource || existing?.publication_source || null;
      const tags = Array.isArray(work.tags) ? textList(work.tags) : parse(existing?.tags_json);
      const identities = Array.isArray(work.characters) ? characterList(work.characters)
        : inferred.get(id) || parse(existing?.characters_json);
      const thumbnailUrl = normalizeArtworkThumbnail(work.thumbnailUrl, id) || normalizeArtworkThumbnail(existing?.thumbnail_url, id) || null;
      sql(`INSERT INTO works(account_id,artwork_id,title,published_at,published_verified,publication_provisional,publication_source,tags_json,characters_json,thumbnail_url,first_seen,last_seen)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(account_id,artwork_id) DO UPDATE SET
        title=excluded.title,published_at=excluded.published_at,tags_json=excluded.tags_json,
        published_verified=excluded.published_verified,publication_provisional=excluded.publication_provisional,publication_source=excluded.publication_source,
        characters_json=excluded.characters_json,thumbnail_url=excluded.thumbnail_url,last_seen=MAX(works.last_seen,excluded.last_seen)`)
        .run(accountId, id, title, publishedAt, publishedVerified, publicationProvisional, publicationSource, JSON.stringify(tags), JSON.stringify(identities), thumbnailUrl, timestamp, timestamp);
      if (publishedAt && publishedAt !== existing?.published_at) {
        // A corrected authoritative publication date invalidates prior age labels,
        // but never deletes the underlying observations.
        sql('DELETE FROM milestones WHERE account_id=? AND artwork_id=?').run(accountId, id);
        for (const point of ANALYTICS_MILESTONES) {
          const target = Date.parse(publishedAt) + point.hours * 3600000;
          sql('INSERT INTO milestones(account_id,artwork_id,point,target_at,window_end) VALUES(?,?,?,?,?)')
            .run(accountId, id, point.key, new Date(target).toISOString(), new Date(target + graceMs).toISOString());
        }
        attachMilestones(accountId, id);
      }
      if (publicationProvisional) sql(`UPDATE milestones SET status='pending',sample_id=NULL,lateness_ms=NULL,reason='publication_time_unverified'
        WHERE account_id=? AND artwork_id=?`).run(accountId, id);
      else if (existing?.publication_provisional) attachMilestones(accountId, id);
    }
    return valid.length;
  }

  function attachMilestones(accountId, artworkId) {
    if (sql('SELECT publication_provisional FROM works WHERE account_id=? AND artwork_id=?').get(accountId, artworkId)?.publication_provisional) return;
    const nodes = sql('SELECT * FROM milestones WHERE account_id=? AND artwork_id=?').all(accountId, artworkId);
    for (const node of nodes) {
      const sample = sql(`SELECT id,observed_at FROM samples WHERE account_id=? AND artwork_id=? AND observed_at>=? AND observed_at<=?
        AND (views IS NOT NULL OR bookmarks IS NOT NULL OR likes IS NOT NULL) ORDER BY observed_at,id LIMIT 1`)
        .get(accountId, artworkId, node.target_at, node.window_end);
      if (sample) sql(`UPDATE milestones SET status='recorded',sample_id=?,lateness_ms=?,reason=NULL WHERE account_id=? AND artwork_id=? AND point=?`)
        .run(sample.id, Date.parse(sample.observed_at) - Date.parse(node.target_at), accountId, artworkId, node.point);
    }
  }

  function markMissedMilestones(at = clock()) {
    const timestamp = iso(at);
    if (!timestamp) throw new Error('Invalid analytics time');
    return sql(`UPDATE milestones SET status='missing',reason='missed_window' WHERE status='pending' AND window_end<?
      AND EXISTS(SELECT 1 FROM works w WHERE w.account_id=milestones.account_id AND w.artwork_id=milestones.artwork_id AND w.publication_provisional=0)`).run(timestamp).changes;
  }

  function recordBatch(accountId, { works = [], account, observedAt, runId, kind = 'periodic', characters = [] } = {}) {
    accountKey(accountId);
    const timestamp = iso(observedAt) || clock();
    const runKey = String(runId || `${kind}:${timestamp}`);
    return transaction(() => {
      upsertInternal(accountId, works, { observedAt: timestamp, characters });
      let recorded = 0;
      const successfulTimes = [];
      for (const work of works) {
        if (!work || work.artworkId == null || !String(work.artworkId).trim()) continue;
        const metrics = work.metrics || work;
        const values = METRICS.map(metric => number(metrics[metric]));
        // A failed detail request is not a zero sample and must not replace the
        // last successfully observed values or satisfy a milestone.
        if (values.every(value => value === null)) continue;
        const id = String(work.artworkId), at = iso(work.observedAt) || timestamp;
        const result = sql(`INSERT INTO samples(account_id,artwork_id,observed_at,run_key,kind,views,bookmarks,likes)
          VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(account_id,artwork_id,run_key) DO NOTHING`)
          .run(accountId, id, at, runKey, String(kind), ...values);
        recorded += result.changes;
        if (result.changes) successfulTimes.push(at);
        attachMilestones(accountId, id);
      }
      let accountRecorded = false;
      if (account && (number(account.views) !== null || number(account.followers) !== null)) {
        const at = iso(account.observedAt) || timestamp;
        accountRecorded = Boolean(sql(`INSERT INTO account_samples(account_id,observed_at,run_key,views,followers,source_json)
          VALUES(?,?,?,?,?,?) ON CONFLICT(account_id,run_key) DO NOTHING`)
          .run(accountId, at, runKey, number(account.views), number(account.followers), JSON.stringify(account.sources || {})).changes);
        if (accountRecorded) successfulTimes.push(at);
      }
      // Freeze the per-identity launch cutoff on the first successful reading.
      // Retries, restarts, or later arrivals with an older timestamp cannot move it.
      if (successfulTimes.length) sql(`INSERT INTO analytics_accounts(account_id,enabled_at) VALUES(?,?)
        ON CONFLICT(account_id) DO NOTHING`).run(accountId, successfulTimes.sort()[0]);
      markMissedMilestones(timestamp);
      return { recorded, accountRecorded, observedAt: timestamp, runId: runKey };
    });
  }

  function upsertWorks(accountId, works, options = {}) {
    return transaction(() => { const count = upsertInternal(accountId, works, options); markMissedMilestones(options.observedAt || clock()); return { count }; });
  }

  function dueMilestones({ accountId, accountIds, now: at = clock(), limit = 200 } = {}) {
    const timestamp = iso(at);
    if (!timestamp) throw new Error('Invalid analytics time');
    markMissedMilestones(timestamp);
    const allowed = scope(accountId, accountIds, 'm.');
    const query = `SELECT m.*,w.title,w.published_at FROM milestones m JOIN works w USING(account_id,artwork_id)
      ${allowed.where || ' WHERE 1'} AND w.publication_provisional=0 AND m.status='pending' AND m.target_at<=? AND m.window_end>=?
      ORDER BY m.target_at,m.account_id,m.artwork_id LIMIT ?`;
    const args = [...allowed.args, timestamp, timestamp, Math.max(1, Math.min(10000, Math.trunc(Number(limit) || 200)))];
    return sql(query).all(...args).map(row => ({ accountId: row.account_id, artworkId: row.artwork_id,
      title: row.title, publishedAt: row.published_at, point: row.point, targetAt: row.target_at, windowEnd: row.window_end }));
  }

  function accountHistory(accountId, limit = 200) {
    return sql('SELECT * FROM account_samples WHERE account_id=? ORDER BY observed_at DESC,id DESC LIMIT ?')
      .all(accountId, Math.max(1, Math.min(10000, Math.trunc(Number(limit) || 200)))).reverse().map(row => ({
        observedAt: row.observed_at, views: row.views, followers: row.followers, sources: parse(row.source_json, {}),
      }));
  }

  function accountTotals(accountId, timestamp) {
    // Select one actual observation per work before summing. Mixing older
    // non-null fields into a newer partial reading would overstate coverage.
    const row = sql(`SELECT COUNT(w.artwork_id) work_count,
      SUM(s.views) views,SUM(s.bookmarks) bookmarks,SUM(s.likes) likes,
      COUNT(s.views) views_count,COUNT(s.bookmarks) bookmarks_count,COUNT(s.likes) likes_count,
      MAX(s.observed_at) observed_at FROM works w LEFT JOIN samples s ON s.id=(
        SELECT latest.id FROM samples latest WHERE latest.account_id=w.account_id AND latest.artwork_id=w.artwork_id
          AND latest.observed_at<=? ORDER BY latest.observed_at DESC,latest.id DESC LIMIT 1
      ) WHERE w.account_id=?`).get(timestamp, accountId);
    return { views: row.views, bookmarks: row.bookmarks, likes: row.likes, workCount: row.work_count,
      metricCounts: { views: row.views_count, bookmarks: row.bookmarks_count, likes: row.likes_count },
      observedAt: row.observed_at };
  }

  function completePeriodicRun(accountId, { runId, completedAt, expectedWorkCount, origin = 'completed' } = {}) {
    if (typeof accountId !== 'string' || !accountId || typeof runId !== 'string' || !runId || !iso(completedAt)
      || !Number.isSafeInteger(expectedWorkCount) || expectedWorkCount < 1) return false;
    const existing = sql('SELECT invalid_reason FROM analytics_periodic_totals WHERE account_id=? AND run_key=?').get(accountId, runId);
    if (existing) return !existing.invalid_reason;
    const timestamp = iso(completedAt);
    // The collector supplies the current complete Pixiv index count. Retained
    // local history may include deleted works and is not today's account scope.
    const readings = sql(`SELECT s.id,s.artwork_id,s.observed_at,s.views,s.bookmarks,s.likes FROM samples s JOIN works w USING(account_id,artwork_id)
      WHERE s.account_id=? AND s.run_key=? AND s.kind='periodic' AND w.first_seen<=? ORDER BY s.artwork_id`).all(accountId, runId, timestamp);
    if (readings.length !== expectedWorkCount || readings.some(row => row.observed_at > timestamp)) return false;
    const counts = METRICS.map(metric => readings.filter(row => row[metric] !== null).length);
    const totals = METRICS.map((metric, index) => counts[index] ? readings.reduce((sum, row) => sum + (row[metric] ?? 0), 0) : null);
    const times = readings.map(row => row.observed_at).sort();
    const invalidReason = Date.parse(times.at(-1)) - Date.parse(times[0]) > ANALYTICS_INTERVAL_MS ? 'observation_span' : null;
    const sampleOrder = readings.reduce((last, row) => Math.max(last, row.id), 0);
    const hash = createHash('sha256').update(readings.map(row => row.artwork_id).join('\0')).digest('hex');
    sql(`INSERT INTO analytics_periodic_totals(account_id,run_key,start_at,end_at,completed_at,work_count,
      views,bookmarks,likes,views_count,bookmarks_count,likes_count,scope_hash,origin,invalid_reason,sample_order) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(account_id,run_key) DO NOTHING`).run(accountId, runId, times[0], times.at(-1), timestamp, expectedWorkCount, ...totals, ...counts, hash, origin, invalidReason, sampleOrder);
    return !invalidReason;
  }

  function accountDaily(accountId, timestamp, days) {
    const range = dailyRange(timestamp, days);
    const accountObservations = sql(`SELECT * FROM account_samples WHERE account_id=? AND observed_at>=? AND observed_at<=?
      ORDER BY observed_at,id`).all(accountId, range.queryFrom, timestamp);
    for (const condition of ['views IS NOT NULL', `followers IS NOT NULL AND json_extract(source_json,'$.followerCount.seriesId')='${DAILY_FOLLOWER_SERIES}'`]) {
      const earlier = sql(`SELECT * FROM account_samples WHERE account_id=? AND observed_at<? AND ${condition} ORDER BY observed_at DESC,id DESC LIMIT 1`).get(accountId, range.queryFrom);
      if (earlier && !accountObservations.some(row => row.id === earlier.id)) accountObservations.push(earlier);
    }
    const periodicObservations = sql(`SELECT * FROM analytics_periodic_totals WHERE account_id=? AND end_at>=? AND end_at<=? AND completed_at<=?
      ORDER BY end_at,id`).all(accountId, range.queryFrom, timestamp, timestamp);
    for (const metric of ['bookmarks', 'likes']) {
      const earlier = sql(`SELECT * FROM analytics_periodic_totals WHERE account_id=? AND end_at<? AND completed_at<=?
        AND work_count>0 AND ${metric}_count=work_count AND invalid_reason IS NULL ORDER BY end_at DESC,id DESC LIMIT 1`).get(accountId, range.queryFrom, timestamp);
      if (earlier && !periodicObservations.some(row => row.id === earlier.id)) periodicObservations.push(earlier);
    }
    const firstObservedAt = sql(`SELECT MIN(at) at FROM (
      SELECT MIN(observed_at) at FROM account_samples WHERE account_id=? AND observed_at<=?
      UNION ALL SELECT MIN(end_at) at FROM analytics_periodic_totals WHERE account_id=? AND end_at<=? AND completed_at<=?)`)
      .get(accountId, timestamp, accountId, timestamp, timestamp).at;
    const works = sql('SELECT first_seen,published_at,published_verified FROM works WHERE account_id=?').all(accountId);
    return buildAccountDaily({ timestamp, days, firstObservedAt, accountObservations, periodicObservations, works });
  }

  function unverifiedRecentWorks({ accountId, since = iso(Date.parse(clock()) - 7 * 24 * 3600000), limit = 200 } = {}) {
    accountKey(accountId);
    const cutoff = iso(since);
    if (!cutoff) throw new Error('Invalid analytics publication cutoff');
    return sql(`SELECT account_id,artwork_id,published_at,published_verified,publication_provisional,publication_source FROM works
      WHERE account_id=? AND published_verified=0 AND published_at>=? ORDER BY published_at DESC,artwork_id LIMIT ?`)
      .all(accountId, cutoff, Math.max(1, Math.min(10000, Math.trunc(Number(limit) || 200))))
      .map(row => ({ accountId: row.account_id, artworkId: row.artwork_id, publishedAt: row.published_at,
        publicationTimeVerified: row.publication_provisional ? false : null, createDateSource: row.publication_source || null }));
  }

  function workRow(work, point, metric, timestamp) {
    const node = point === 'current' ? null : sql('SELECT * FROM milestones WHERE account_id=? AND artwork_id=? AND point=?')
      .get(work.account_id, work.artwork_id, point);
    const sample = point === 'current' ? sql(`SELECT * FROM samples WHERE account_id=? AND artwork_id=? AND observed_at<=?
      ORDER BY observed_at DESC,id DESC LIMIT 1`).get(work.account_id, work.artwork_id, timestamp)
      : node?.sample_id ? sql('SELECT * FROM samples WHERE id=? AND observed_at<=?').get(node.sample_id, timestamp) : null;
    const enabledAt = work.enabled_at || null;
    const historical = Boolean(enabledAt && work.published_at && work.published_at < enabledAt);
    const growthEligible = Boolean(point !== 'current' && enabledAt && work.published_at && !historical && !work.publication_provisional);
    const hours = growthEligible && sample ? (Date.parse(sample.observed_at) - Date.parse(work.published_at)) / 3600000 : null;
    const metrics = Object.fromEntries(METRICS.map(key => [key, sample?.[key] ?? null]));
    metrics.bookmarkRate = bookmarkRate(metrics);
    // This is the observed cumulative count per hour of the work's actual age,
    // not a fabricated observation of zero at publication or a later delta.
    const growthMetrics = Object.fromEntries(METRICS.map(key => [key, hours > 0 && sample[key] !== null ? sample[key] / hours : null]));
    growthMetrics.bookmarkRate = null;
    const averageMetrics = { ...metrics, bookmarkRate: null };
    const metricSampleCounts = Object.fromEntries([...METRICS, 'bookmarkRate'].map(key => [key, metrics[key] === null ? 0 : 1]));
    const growthMetricSampleCounts = Object.fromEntries([...METRICS, 'bookmarkRate'].map(key => [key, growthMetrics[key] === null ? 0 : 1]));
    const status = sample ? 'recorded' : point === 'current' ? 'missing' : work.publication_provisional ? 'pending'
      : !work.published_at ? 'missing' : node?.target_at > timestamp ? 'pending' : node?.window_end >= timestamp ? 'pending' : 'missing';
    const total = metrics[metric], growth = growthMetrics[metric];
    const growthExcludedReason = metric === 'bookmarkRate' ? 'ratio_not_defined' : point === 'current' ? 'current_not_comparable' : !enabledAt ? 'analytics_not_enabled'
      : !work.published_at ? 'unknown_publication_time' : work.publication_provisional ? 'publication_time_unverified' : historical ? 'published_before_enabled'
      : status === 'pending' ? 'milestone_pending' : !sample ? 'milestone_missing'
      : total === null ? 'metric_missing' : !(hours > 0) ? 'invalid_observation_age' : null;
    return { id: `${work.account_id}:${work.artwork_id}`, artworkId: work.artwork_id, accountId: work.account_id,
      name: work.title || `作品 ${work.artwork_id}`, title: work.title, url: /^\d+$/.test(work.artwork_id) ? `https://www.pixiv.net/artworks/${work.artwork_id}` : null,
      hasThumbnail: Boolean(normalizeArtworkThumbnail(work.thumbnail_url, work.artwork_id)),
      tags: parse(work.tags_json), characters: parse(work.characters_json), publishedAt: work.published_at,
      publicationTimeVerified: work.published_verified ? true : work.publication_provisional ? false : null, createDateSource: work.publication_source || null,
      samplingBlockedReason: point !== 'current' && work.publication_provisional ? 'publication_time_unverified' : null,
      workCount: 1, sampleCount: total === null ? 0 : 1, missingCount: total === null ? 1 : 0,
      growthSampleCount: growth === null ? 0 : 1, total, average: averageMetrics[metric], growth, metrics, averageMetrics, growthMetrics,
      metricSampleCounts, growthMetricSampleCounts,
      observedAt: sample?.observed_at || null, baselineAt: growthEligible ? work.published_at : null, intervalHours: hours,
      baselineKind: growthEligible ? 'publication_start' : null, enabledAt, growthEligible, growthExcludedReason,
      growthEligibleWorkCount: growthEligible ? 1 : 0, historicalWorkCount: historical ? 1 : 0, growthExcludedCount: growth === null ? 1 : 0,
      targetAt: node?.target_at || null, latenessMs: sample && node ? node.lateness_ms : null,
      lateCount: sample && node?.lateness_ms > 0 ? 1 : 0, status,
      missingReason: status !== 'missing' ? null : !work.published_at && point !== 'current' ? 'unknown_publication_time' : !sample ? point === 'current' ? 'not_observed' : 'missed_window' : null,
    };
  }

  function groupedRows(rows, group, metric) {
    const groups = new Map();
    for (const row of rows) {
      const names = group === 'character' ? row.characters : row.tags.map(name => ({ key: name, name }));
      for (const identity of names) {
        if (!groups.has(identity.key)) groups.set(identity.key, { name: identity.name, rows: [] });
        groups.get(identity.key).rows.push(row);
      }
    }
    return [...groups.entries()].map(([key, value]) => {
      const unique = [...new Map(value.rows.map(row => [row.id, row])).values()];
      const samples = unique.filter(row => row.metrics[metric] !== null), growthSamples = unique.filter(row => row.growthMetrics[metric] !== null);
      const metrics = {}, averageMetrics = {}, growthMetrics = {}, metricSampleCounts = {}, growthMetricSampleCounts = {};
      for (const key of METRICS) {
        const observations = unique.filter(row => row.metrics[key] !== null);
        const growing = unique.filter(row => row.growthMetrics[key] !== null);
        metrics[key] = observations.length ? observations.reduce((sum, row) => sum + row.metrics[key], 0) : null;
        averageMetrics[key] = observations.length ? metrics[key] / observations.length : null;
        growthMetrics[key] = growing.length ? growing.reduce((sum, row) => sum + row.growthMetrics[key], 0) / growing.length : null;
        metricSampleCounts[key] = observations.length;
        growthMetricSampleCounts[key] = growing.length;
      }
      // Both numerator and denominator use exactly the same valid work pairs.
      // An unweighted mean of per-work ratios would favor low-view works.
      const pairs = unique.filter(row => row.metrics.bookmarkRate !== null);
      metrics.bookmarkRate = pairs.length ? pairs.reduce((sum, row) => sum + row.metrics.bookmarks, 0)
        / pairs.reduce((sum, row) => sum + row.metrics.views, 0) : null;
      averageMetrics.bookmarkRate = null; growthMetrics.bookmarkRate = null;
      metricSampleCounts.bookmarkRate = pairs.length; growthMetricSampleCounts.bookmarkRate = 0;
      const total = metrics[metric];
      return { id: key, name: value.name, url: null, accountId: null, workCount: unique.length,
        sampleCount: samples.length, missingCount: unique.length - samples.length, growthSampleCount: growthSamples.length,
        growthEligibleWorkCount: unique.filter(row => row.growthEligible).length,
        historicalWorkCount: unique.filter(row => row.historicalWorkCount).length, growthExcludedCount: unique.length - growthSamples.length,
        total, average: averageMetrics[metric], growth: growthMetrics[metric],
        observedAt: dateMax(unique.map(row => row.observedAt)), lateCount: samples.filter(row => row.lateCount).length,
        metrics, averageMetrics, growthMetrics, metricSampleCounts, growthMetricSampleCounts,
        status: samples.length ? 'recorded' : unique.every(row => row.status === 'pending') ? 'pending' : 'missing',
      };
    });
  }

  function intervalRow(work, point, metric, timestamp) {
    const ratioSelected = metric === 'bookmarkRate';
    const index = ANALYTICS_MILESTONES.findIndex(item => item.key === point);
    const previous = ANALYTICS_MILESTONES[index - 1];
    const interval = { fromPoint: previous?.key || 'publication', toPoint: point,
      startHours: previous?.hours || 0, endHours: ANALYTICS_MILESTONES[index].hours };
    const end = workRow(work, point, metric, timestamp);
    const start = previous ? workRow(work, previous.key, metric, timestamp) : null;
    const intervalStartAt = previous ? start.observedAt : work.published_at;
    const intervalEndAt = end.observedAt;
    const hours = intervalStartAt && intervalEndAt ? (Date.parse(intervalEndAt) - Date.parse(intervalStartAt)) / 3600000 : null;
    const startValues = previous ? start.metrics : Object.fromEntries(METRICS.map(key => [key, 0]));
    const deltaMetrics = Object.fromEntries(METRICS.map(key => [key,
      startValues[key] !== null && end.metrics[key] !== null ? end.metrics[key] - startValues[key] : null]));
    const growthMetrics = Object.fromEntries(METRICS.map(key => [key, hours > 0 && deltaMetrics[key] !== null ? deltaMetrics[key] / hours : null]));
    deltaMetrics.bookmarkRate = null; growthMetrics.bookmarkRate = null;
    const deltaMetricSampleCounts = Object.fromEntries([...METRICS, 'bookmarkRate'].map(key => [key, deltaMetrics[key] === null ? 0 : 1]));
    const growthMetricSampleCounts = Object.fromEntries([...METRICS, 'bookmarkRate'].map(key => [key, growthMetrics[key] === null ? 0 : 1]));
    const delta = deltaMetrics[metric], growth = growthMetrics[metric];
    const total = ratioSelected ? end.metrics.bookmarkRate : delta;
    const endpointProblem = (row, name) => row.metrics[metric] !== null ? null
      : row.status === 'recorded' ? `${name}_metric_missing`
        : row.status === 'pending' ? `${name}_milestone_pending` : `${name}_milestone_missing`;
    const problems = [previous && !ratioSelected ? endpointProblem(start, 'start') : null, endpointProblem(end, 'end')].filter(Boolean);
    // A permanently missed start cannot be recovered by a later end sample.
    const missingReason = problems.find(reason => !reason.endsWith('_pending')) || problems[0]
      || (!ratioSelected && !(hours > 0) ? 'invalid_interval' : null);
    const status = missingReason ? missingReason.endsWith('_pending') ? 'pending' : 'missing' : 'recorded';
    return { ...end, interval, delta, deltaMetrics, growth, growthMetrics, deltaMetricSampleCounts, growthMetricSampleCounts,
      total, average: ratioSelected ? null : delta, averageMetrics: { ...deltaMetrics },
      startValue: startValues[metric] ?? null, endValue: end.metrics[metric],
      fromObservedAt: start?.observedAt || null, toObservedAt: end.observedAt,
      intervalStartAt, intervalEndAt, baselineAt: intervalStartAt, intervalHours: hours > 0 ? hours : null,
      baselineKind: previous ? 'milestone_observation' : 'publication_zero_estimate',
      sampleCount: total === null ? 0 : 1, missingCount: total === null ? 1 : 0,
      growthSampleCount: growth === null ? 0 : 1, growthExcludedCount: growth === null ? 1 : 0,
      positiveGrowth: growth !== null && growth > 0, counterDecreased: delta !== null && delta < 0,
      growthExcludedReason: ratioSelected ? 'ratio_not_defined' : missingReason, status, missingReason,
      startTargetAt: start?.targetAt || work.published_at,
      startLatenessMs: start?.latenessMs ?? null, endLatenessMs: end.latenessMs,
      lateCount: start?.lateCount || end.lateCount ? 1 : 0,
    };
  }

  function report(options = {}) {
    const timestamp = iso(options.now) || clock();
    markMissedMilestones(timestamp);
    const accountId = typeof options.accountId === 'string' && options.accountId !== 'all' ? options.accountId : 'all';
    const group = ['character', 'tag', 'interval'].includes(options.group) ? options.group : 'work';
    const point = ANALYTICS_MILESTONES.some(item => item.key === options.point) ? options.point : group === 'interval' ? '6h' : 'current';
    const metric = [...METRICS, 'bookmarkRate'].includes(options.metric) ? options.metric : 'views';
    const sort = metric === 'bookmarkRate' ? 'total' : ['total', 'average', 'growth'].includes(options.sort) ? options.sort : group === 'interval' ? 'growth' : 'total';
    const days = ['30', '90', '180', '365'].includes(String(options.days)) ? String(options.days) : 'all';
    const publicationFrom = days === 'all' ? null : new Date(Date.parse(timestamp) - Number(days) * 86400000).toISOString();
    const query = typeof options.query === 'string' ? options.query.trim() : '';
    const limit = Math.max(1, Math.min(200, Math.trunc(Number(options.limit) || 25))), offset = Math.max(0, Math.trunc(Number(options.offset) || 0));
    const allowed = scope(accountId, options.accountIds);
    const trackedWorks = sql(`SELECT works.*,analytics_accounts.enabled_at FROM works LEFT JOIN analytics_accounts USING(account_id)${allowed.where}`).all(...allowed.args);
    const works = publicationFrom ? trackedWorks.filter(work => work.published_at && work.published_at >= publicationFrom && work.published_at <= timestamp) : trackedWorks;
    const allRows = works.map(work => workRow(work, point, metric, timestamp));
    const rankingRows = group === 'interval' ? works.filter(work => work.published_verified === 1 && work.enabled_at && work.published_at >= work.enabled_at)
      .map(work => intervalRow(work, point, metric, timestamp)) : sort === 'growth' ? allRows.filter(row => row.growthEligible) : allRows;
    let rows = ['work', 'interval'].includes(group) ? rankingRows : groupedRows(rankingRows, group, metric);
    if (query) { const needle = normalize(query); rows = rows.filter(row => normalize([row.name, ...(row.tags || []), ...(row.characters || []).map(character => character.name)].join(' ')).includes(needle)); }
    rows.sort((a, b) => a[sort] === null ? b[sort] === null ? a.name.localeCompare(b.name) : 1 : b[sort] === null ? -1 : b[sort] - a[sort] || b.sampleCount - a.sampleCount || a.name.localeCompare(b.name));
    const accountIds = sql(`SELECT account_id FROM (SELECT account_id FROM works UNION SELECT account_id FROM account_samples)${allowed.where}`)
      .all(...allowed.args).map(row => row.account_id);
    return { generatedAt: timestamp, filters: { accountId, point, group, metric, sort, query, days },
      summary: { workCount: rankingRows.length, sampledWorkCount: rankingRows.filter(row => row.sampleCount).length,
        missingWorkCount: rankingRows.filter(row => row.status === 'missing' || row.status === 'recorded' && !row.sampleCount).length,
        pendingWorkCount: rankingRows.filter(row => row.status === 'pending').length, lateWorkCount: rankingRows.filter(row => row.lateCount).length,
        growthSampleCount: rankingRows.filter(row => row.growthSampleCount).length,
        growthEligibleWorkCount: group === 'interval' ? rankingRows.length : allRows.filter(row => row.growthEligible).length,
        historicalWorkCount: allRows.filter(row => row.historicalWorkCount).length,
        excludedHistoricalCount: sort === 'growth' || group === 'interval' ? allRows.filter(row => row.historicalWorkCount).length : 0,
        positiveGrowthWorkCount: rankingRows.filter(row => row.growth > 0).length,
        totalTrackedWorkCount: allRows.length, trackedWorkCountBeforeDateFilter: trackedWorks.length,
        excludedByDateCount: trackedWorks.length - works.length },
      rows: rows.slice(offset, offset + limit), pagination: { total: rows.length, limit, offset },
      accounts: accountIds.map(id => { const history = accountHistory(id, options.historyLimit || 200); return { accountId: id,
        enabledAt: sql('SELECT enabled_at FROM analytics_accounts WHERE account_id=?').get(id)?.enabled_at || null,
        latest: history.at(-1) || null, history, totals: accountTotals(id, timestamp), daily: accountDaily(id, timestamp, options.dailyDays) }; }),
      methodology: { graceMinutes: graceMs / 60000, growthUnit: 'per_hour_per_work',
        growthBaseline: group === 'interval' ? point === '6h' ? 'publication_zero_estimate' : 'adjacent_milestone_observations'
          : point === 'current' ? null : 'publication_to_observation', growthAvailable: metric !== 'bookmarkRate' && point !== 'current',
        bookmarkRate: 'sum_bookmarks_divided_by_sum_views_for_valid_pairs', bookmarkRateUnit: 'ratio',
        growthScope: 'published_on_or_after_account_enabled_at',
        publicationDateRange: { days, from: publicationFrom, to: publicationFrom ? timestamp : null },
        intervalRequiresVerifiedPublication: group === 'interval',
        missingValues: 'excluded_not_zero', milestonePolicy: 'first_actual_observation_within_window',
        note: group === 'interval'
          ? '分时段增长仅比较启用统计后发布、且发布时间已经核实的新作品。0–6 小时以发布时累计为 0 推算；其他时段使用相邻两个节点的真实数据差除以实际采样间隔。缺失节点不补造，计数下降保留负值且不作为正增长冠军。'
          : '增长仅比较各账号启用统计后发布的新作品：将节点真实累计数据除以发布至实际采样的小时数，再按有效作品取平均，表示发布至节点的平均新增。当前值不参与增长比较，历史作品不进入增长榜。错过的节点不补造。' },
    };
  }

  function status({ accountId, accountIds, now: at = clock() } = {}) {
    markMissedMilestones(at);
    const { where, args } = scope(accountId, accountIds);
    const counts = sql(`SELECT status,COUNT(*) count FROM milestones${where} GROUP BY status`).all(...args);
    const next = sql(`SELECT MIN(target_at) at FROM milestones${where ? `${where} AND` : ' WHERE'} status='pending'
      AND EXISTS(SELECT 1 FROM works w WHERE w.account_id=milestones.account_id AND w.artwork_id=milestones.artwork_id AND w.publication_provisional=0)`).get(...args);
    return { workCount: sql(`SELECT COUNT(*) count FROM works${where}`).get(...args).count,
      sampleCount: sql(`SELECT COUNT(*) count FROM samples${where}`).get(...args).count,
      accountSampleCount: sql(`SELECT COUNT(*) count FROM account_samples${where}`).get(...args).count,
      milestones: Object.fromEntries(['pending', 'recorded', 'missing'].map(key => [key, counts.find(row => row.status === key)?.count || 0])),
      nextMilestoneAt: next.at, graceMinutes: graceMs / 60000,
      lastObservedAt: sql(`SELECT MAX(observed_at) at FROM samples${where}`).get(...args).at };
  }

  return { databasePath, upsertWorks, recordBatch, dueMilestones, markMissedMilestones, report, accountHistory, status, unverifiedRecentWorks, completePeriodicRun,
    getWorkThumbnail({ accountId, artworkId } = {}) {
      if (typeof accountId !== 'string' || !accountId || !/^\d+$/.test(String(artworkId || ''))) return null;
      const row = sql('SELECT thumbnail_url FROM works WHERE account_id=? AND artwork_id=?').get(accountId, String(artworkId));
      return normalizeArtworkThumbnail(row?.thumbnail_url, String(artworkId)) || null;
    },
    getEnabledAt(accountId) { return sql('SELECT enabled_at FROM analytics_accounts WHERE account_id=?').get(accountId)?.enabled_at || null; },
    getMeta(key, fallback = null) { const row = sql('SELECT value_json FROM analytics_meta WHERE key=?').get(String(key)); return row ? parse(row.value_json, fallback) : fallback; },
    setMeta(key, value) { sql('INSERT INTO analytics_meta(key,value_json) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json').run(String(key), JSON.stringify(value)); },
    close() { db.close(); },
  };
}
