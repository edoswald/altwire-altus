/**
 * Story opportunities: Google searches where AltWire ranks on page 1–3
 * (positions 5–30) and could do better with a new or refreshed piece.
 *
 * A scan (weekday cron `story_scan`, or get_story_opportunities refresh=true):
 *   1. Search Console opportunity-zone queries for the last 28 days (lag
 *      aware) and the 28 days before, for trend.
 *   2. One row per query (its best-performing page), translated pages and the
 *      brand query dropped.
 *   3. Pre-rank by impressions × closeness to the top; the best candidates get
 *      a hybrid archive search (meaning + keywords + reranker) to see how well
 *      AltWire already covers the topic.
 *   4. Final score = pre-rank × coverage gap; the top results are upserted
 *      into altus_story_queue with a plain-language reason.
 *
 * The queue keeps state across scans: first/last seen, status (open, done,
 * dismissed, expired), and a note. Rows not seen for EXPIRE_DAYS expire;
 * done or dismissed rows stay closed when seen again. No LLM is involved:
 * the agent reading the queue does the editorial judgment.
 */

import pool from '../lib/altus-db.js';
import { getLagAwareGscWindow, isoDateOffset } from '../lib/gsc-date-window.js';
import { logger } from '../logger.js';
import { getOpportunityZoneQueries } from './altwire-gsc-client.js';
import { searchAltwireArchive } from './altus-search.js';

export const WINDOW_DAYS = 28;
export const CANDIDATES = 15;
export const KEEP = 10;
export const EXPIRE_DAYS = 14;
const SEARCH_CONCURRENCY = 5;
const LAG_DAYS = 3;
const BRAND_RE = /\baltwire\b|\balt wire\b/i;
const TRANSLATED_PATH_RE = /^https?:\/\/[^/]+\/[a-z]{2}(?:-[a-z]{2})?\//i;

const normalizeUrl = (u) => (typeof u === 'string' ? u.replace(/\/+$/, '').toLowerCase() : null);

export async function ensureStoryQueueTable(client = pool) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS altus_story_queue (
      id                SERIAL PRIMARY KEY,
      query_key         TEXT NOT NULL UNIQUE,
      query             TEXT NOT NULL,
      page_url          TEXT,
      page_title        TEXT,
      page_published_at TIMESTAMPTZ,
      impressions       INTEGER NOT NULL DEFAULT 0,
      clicks            INTEGER NOT NULL DEFAULT 0,
      position          NUMERIC(5,1),
      prev_impressions  INTEGER,
      prev_position     NUMERIC(5,1),
      coverage_status   TEXT NOT NULL DEFAULT 'unknown',
      best_match        JSONB,
      suggestion        TEXT,
      reason            TEXT,
      score             NUMERIC(12,2) NOT NULL DEFAULT 0,
      status            TEXT NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open', 'done', 'dismissed', 'expired')),
      note              TEXT,
      window_start      DATE,
      window_end        DATE,
      first_seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      status_changed_at TIMESTAMPTZ
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS altus_story_queue_open_idx
      ON altus_story_queue (status, score DESC)
  `);
}

/** 1 at position ≤5, falling linearly to 0 at 30. */
export function positionProximity(position) {
  const p = Math.max(5, Math.min(30, Number(position) || 30));
  return 1 - (p - 5) / 25;
}

/**
 * One row per query from Search Console [query, page] rows: the page with the
 * most impressions, skipping translated pages and the brand query.
 */
export function bestRowPerQuery(rows) {
  const best = new Map();
  for (const row of rows ?? []) {
    const query = row.keys?.[0];
    const page = row.keys?.[1] ?? null;
    if (!query || BRAND_RE.test(query)) continue;
    if (page && TRANSLATED_PATH_RE.test(page)) continue;
    if (row.position < 5 || row.position > 30) continue;
    const key = query.trim().toLowerCase();
    const current = best.get(key);
    if (!current || (row.impressions ?? 0) > (current.impressions ?? 0)) {
      best.set(key, { key, query, page, impressions: row.impressions ?? 0, clicks: row.clicks ?? 0, position: row.position });
    }
  }
  return [...best.values()];
}

/** Previous-window metrics per query key (summed across pages, best position). */
export function previousByQuery(rows) {
  const prev = new Map();
  for (const row of rows ?? []) {
    const query = row.keys?.[0];
    if (!query) continue;
    const key = query.trim().toLowerCase();
    const p = prev.get(key) ?? { impressions: 0, position: null };
    p.impressions += row.impressions ?? 0;
    p.position = p.position == null ? row.position : Math.min(p.position, row.position);
    prev.set(key, p);
  }
  return prev;
}

/**
 * How well the archive covers a query, from the best hybrid-search result.
 * Reranker relevance is a calibrated 0–1 score; without it (rerank failed or
 * search errored) coverage is unknown rather than assumed missing.
 */
export function classifyCoverage(search) {
  if (!search || search.error || !Array.isArray(search.results)) return { status: 'unknown', multiplier: 1.0, best: null };
  const top = search.results[0];
  if (!top) return { status: 'none', multiplier: 1.5, best: null };
  const best = { title: top.title, url: top.url, published_at: top.published_at, relevance: top.relevance ?? null };
  if (search.ranking !== 'reranked' || top.relevance == null) return { status: 'unknown', multiplier: 1.0, best };
  if (top.relevance >= 0.7) return { status: 'dedicated', multiplier: 1.0, best };
  if (top.relevance >= 0.35) return { status: 'partial', multiplier: 1.25, best };
  return { status: 'none', multiplier: 1.5, best };
}

function yearsSince(date, now) {
  if (!date) return null;
  return (now - new Date(date).getTime()) / (365.25 * 86400000);
}

/** What to do about an opportunity, and a one-line reason. Pure; exported for tests. */
export function describeOpportunity(o, now = Date.now()) {
  const pos = Number(o.position).toFixed(1);
  const parts = [`#${pos} for "${o.query}"`, `${o.impressions.toLocaleString('en-US')} impressions in ${WINDOW_DAYS} days`];
  if (o.prev_position != null) {
    const delta = Number(o.prev_position) - Number(o.position);
    if (Math.abs(delta) >= 1) parts.push(delta > 0 ? `up from #${Number(o.prev_position).toFixed(1)}` : `down from #${Number(o.prev_position).toFixed(1)}`);
  } else {
    parts.push('new this window');
  }
  if (o.prev_impressions) {
    const change = Math.round(((o.impressions - o.prev_impressions) / o.prev_impressions) * 100);
    if (Math.abs(change) >= 25) parts.push(`impressions ${change > 0 ? '+' : ''}${change}%`);
  }

  let suggestion;
  const best = o.best_match;
  const bestIsRankingPage = best?.url && normalizeUrl(best.url) === normalizeUrl(o.page_url);
  const bestAge = yearsSince(best?.published_at, now);
  if (o.coverage_status === 'dedicated') {
    suggestion = bestAge != null && bestAge >= 1 ? 'refresh' : 'optimize';
    parts.push(bestIsRankingPage
      ? `the ranking page covers it${bestAge != null ? ` (published ${Math.floor(bestAge * 12)} months ago)` : ''}`
      : `"${best.title}" covers it but isn't the page ranking`);
  } else if (o.coverage_status === 'partial') {
    suggestion = 'expand';
    parts.push(`closest coverage is "${best?.title}"`);
  } else if (o.coverage_status === 'none') {
    suggestion = 'new_story';
    parts.push('no dedicated AltWire piece');
  } else {
    suggestion = 'check_coverage';
    parts.push('coverage unknown (archive search unavailable)');
  }
  return { suggestion, reason: parts.join('; ') };
}

async function lookupPages(urls) {
  const list = [...new Set(urls.filter(Boolean).map((u) => u.replace(/\/+$/, '')))];
  if (!list.length) return new Map();
  const { rows } = await pool.query(
    `SELECT lower(rtrim(url, '/')) AS key, title, published_at FROM altus_content WHERE rtrim(url, '/') = ANY($1)`,
    [list],
  );
  return new Map(rows.map((r) => [r.key, r]));
}

/**
 * Run a scan and update the queue.
 * @returns {Promise<{ scanned: number, candidates: number, kept: number, expired: number, window: object } | { error: string }>}
 */
export async function runStoryScan({ deps = {} } = {}) {
  const {
    gsc = getOpportunityZoneQueries,
    search = searchAltwireArchive,
    pages = lookupPages,
    now = Date.now(),
  } = deps;

  await ensureStoryQueueTable();
  const window = getLagAwareGscWindow(WINDOW_DAYS, LAG_DAYS);
  const prevWindow = { startDate: isoDateOffset(WINDOW_DAYS * 2 + LAG_DAYS), endDate: isoDateOffset(WINDOW_DAYS + LAG_DAYS + 1) };

  const [current, previous] = await Promise.all([
    gsc(window.startDate, window.endDate, { limit: Infinity }),
    gsc(prevWindow.startDate, prevWindow.endDate, { limit: Infinity }),
  ]);
  if (current?.error) return { error: `Search Console: ${current.message ?? current.error}` };

  const rows = bestRowPerQuery(current.rows);
  const prev = previous?.error ? new Map() : previousByQuery(previous?.rows);
  const candidates = rows
    .map((r) => ({ ...r, pre: r.impressions * positionProximity(r.position) }))
    .sort((a, b) => b.pre - a.pre)
    .slice(0, CANDIDATES);

  // Five at a time to stay inside Voyage rate limits (a failed rerank would
  // turn into "coverage unknown").
  const searches = [];
  for (let i = 0; i < candidates.length; i += SEARCH_CONCURRENCY) {
    const chunk = candidates.slice(i, i + SEARCH_CONCURRENCY);
    searches.push(...await Promise.all(chunk.map((c) => Promise.resolve()
      .then(() => search({ query: c.query, limit: 3, content_type: 'post' }))
      .catch((err) => ({ error: err.message })))));
  }
  const pageInfo = await pages(candidates.map((c) => c.page)).catch(() => new Map());

  const scored = candidates.map((c, i) => {
    const coverage = classifyCoverage(searches[i]);
    const page = pageInfo.get(normalizeUrl(c.page));
    const p = prev.get(c.key);
    const o = {
      query_key: c.key,
      query: c.query,
      page_url: c.page,
      page_title: page?.title ?? null,
      page_published_at: page?.published_at ?? null,
      impressions: Math.round(c.impressions),
      clicks: Math.round(c.clicks),
      position: Math.round(c.position * 10) / 10,
      prev_impressions: p ? Math.round(p.impressions) : null,
      prev_position: p?.position != null ? Math.round(p.position * 10) / 10 : null,
      coverage_status: coverage.status,
      best_match: coverage.best,
      score: Math.round(c.pre * coverage.multiplier * 100) / 100,
    };
    return { ...o, ...describeOpportunity(o, now) };
  }).sort((a, b) => b.score - a.score).slice(0, KEEP);

  const client = await pool.connect();
  let expired = 0;
  try {
    await client.query('BEGIN');
    for (const o of scored) {
      await client.query(
        `INSERT INTO altus_story_queue
           (query_key, query, page_url, page_title, page_published_at, impressions, clicks, position,
            prev_impressions, prev_position, coverage_status, best_match, suggestion, reason, score,
            window_start, window_end)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         ON CONFLICT (query_key) DO UPDATE SET
           query = EXCLUDED.query, page_url = EXCLUDED.page_url, page_title = EXCLUDED.page_title,
           page_published_at = EXCLUDED.page_published_at, impressions = EXCLUDED.impressions,
           clicks = EXCLUDED.clicks, position = EXCLUDED.position, prev_impressions = EXCLUDED.prev_impressions,
           prev_position = EXCLUDED.prev_position, coverage_status = EXCLUDED.coverage_status,
           best_match = EXCLUDED.best_match, suggestion = EXCLUDED.suggestion, reason = EXCLUDED.reason,
           score = EXCLUDED.score, window_start = EXCLUDED.window_start, window_end = EXCLUDED.window_end,
           last_seen_at = NOW(),
           status = CASE WHEN altus_story_queue.status = 'expired' THEN 'open' ELSE altus_story_queue.status END,
           status_changed_at = CASE WHEN altus_story_queue.status = 'expired' THEN NOW() ELSE altus_story_queue.status_changed_at END`,
        [
          o.query_key, o.query, o.page_url, o.page_title, o.page_published_at, o.impressions, o.clicks, o.position,
          o.prev_impressions, o.prev_position, o.coverage_status, o.best_match ? JSON.stringify(o.best_match) : null,
          o.suggestion, o.reason, o.score, window.startDate, window.endDate,
        ],
      );
    }
    const res = await client.query(
      `UPDATE altus_story_queue SET status = 'expired', status_changed_at = NOW()
        WHERE status = 'open' AND last_seen_at < NOW() - ($1 || ' days')::interval`,
      [String(EXPIRE_DAYS)],
    );
    expired = res.rowCount ?? 0;
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const summary = { scanned: rows.length, candidates: candidates.length, kept: scored.length, expired, window };
  logger.info('Story scan complete', summary);
  return summary;
}

function rowToOpportunity(r) {
  const num = (v) => (v == null ? null : Number(v));
  return {
    id: r.id,
    query: r.query,
    suggestion: r.suggestion,
    reason: r.reason,
    ranking_page: r.page_url ? { url: r.page_url, title: r.page_title, published_at: r.page_published_at } : null,
    search: {
      impressions: r.impressions,
      clicks: r.clicks,
      position: num(r.position),
      previous_impressions: r.prev_impressions,
      previous_position: num(r.prev_position),
      window: r.window_start ? { start: r.window_start, end: r.window_end } : null,
    },
    coverage: { status: r.coverage_status, best_match: r.best_match },
    score: num(r.score),
    status: r.status,
    note: r.note,
    first_seen_at: r.first_seen_at,
    last_seen_at: r.last_seen_at,
  };
}

/**
 * Read the queue. status 'open' (default) | 'done' | 'dismissed' | 'expired' | 'all'.
 */
export async function listStoryQueue({ status = 'open', limit = 10 } = {}) {
  await ensureStoryQueueTable();
  const params = [];
  let where = '';
  if (status !== 'all') {
    params.push(status);
    where = 'WHERE status = $1';
  }
  params.push(Math.min(Math.max(Number(limit) || 10, 1), 50));
  const { rows } = await pool.query(
    `SELECT * FROM altus_story_queue ${where}
      ORDER BY (status = 'open') DESC, score DESC, last_seen_at DESC
      LIMIT $${params.length}`,
    params,
  );
  const { rows: [meta] } = await pool.query(
    `SELECT MAX(last_seen_at) AS last_scan_at, COUNT(*) FILTER (WHERE status = 'open')::int AS open FROM altus_story_queue`,
  );
  return { opportunities: rows.map(rowToOpportunity), open_count: meta?.open ?? 0, last_scan_at: meta?.last_scan_at ?? null };
}

/** Mark an opportunity done, dismissed, or open again, with an optional note. */
export async function updateStoryOpportunity({ id, status, note }) {
  await ensureStoryQueueTable();
  const { rows } = await pool.query(
    `UPDATE altus_story_queue
        SET status = COALESCE($2, status),
            note = COALESCE($3, note),
            status_changed_at = CASE WHEN $2::text IS NOT NULL AND $2::text <> status THEN NOW() ELSE status_changed_at END
      WHERE id = $1
      RETURNING *`,
    [id, status ?? null, note ?? null],
  );
  if (!rows.length) return { error: `No story opportunity with id ${id}` };
  return { updated: rowToOpportunity(rows[0]) };
}
