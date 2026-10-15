/**
 * Article performance: how each new post did in its first 3, 7, and 30 days.
 *
 * Every post published in the last TRACK_DAYS days is tracked automatically
 * (no registration). A checkpoint's window is anchored to the publish date
 * (publish day through publish day + N - 1, in AltWire's time zone) and is
 * taken once Search Console's ~3-day lag has passed. Each snapshot records
 * Matomo pageviews and visits, Google web search totals and top queries, and
 * Google News totals for that window. If any source errors, nothing is
 * written and the next daily run retries.
 *
 * Reads compare an article with AltWire's typical article at the same
 * checkpoint (median and percentile across all snapshots).
 */

import pool from '../lib/altus-db.js';
import { logger } from '../logger.js';
import { getPageSearchDetail } from './altwire-gsc-client.js';
import { getPageUrlStats } from './altwire-matomo-client.js';

export const CHECKPOINTS = [3, 7, 30];
export const TRACK_DAYS = 40;
export const GSC_LAG_DAYS = 3;
const TIME_ZONE = 'America/New_York';

const normalizeUrl = (u) => (typeof u === 'string' ? u.replace(/\/+$/, '').toLowerCase() : null);

export async function ensureSnapshotTable(client = pool) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS altus_article_snapshots (
      id                 SERIAL PRIMARY KEY,
      url                TEXT NOT NULL,
      url_key            TEXT NOT NULL,
      wp_id              INTEGER,
      title              TEXT,
      published_at       TIMESTAMPTZ NOT NULL,
      checkpoint_days    INTEGER NOT NULL,
      window_start       DATE NOT NULL,
      window_end         DATE NOT NULL,
      pageviews          INTEGER NOT NULL,
      visits             INTEGER NOT NULL,
      search_clicks      INTEGER NOT NULL,
      search_impressions INTEGER NOT NULL,
      search_position    NUMERIC(6,1),
      news_clicks        INTEGER NOT NULL,
      news_impressions   INTEGER NOT NULL,
      top_queries        JSONB NOT NULL DEFAULT '[]'::jsonb,
      taken_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (url_key, checkpoint_days)
    )
  `);
}

/** Calendar date (YYYY-MM-DD) of an instant in AltWire's time zone. */
export function localDate(instant, timeZone = TIME_ZONE) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(instant));
}

function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Checkpoints due for a post: window [publish day, publish day + N - 1],
 * due once window end + lag ≤ today, and not already taken.
 */
export function dueCheckpoints(publishedAt, taken, today, { lag = GSC_LAG_DAYS } = {}) {
  const start = localDate(publishedAt);
  return CHECKPOINTS
    .filter((n) => !taken.has(n))
    .map((n) => ({ days: n, start, end: addDays(start, n - 1) }))
    .filter((c) => addDays(c.end, lag) <= today);
}

/**
 * Take every due snapshot for recent posts. Deps are injectable for tests.
 * @returns {Promise<{ posts: number, taken: number, skipped: number }>}
 */
export async function runArticleSnapshots({ deps = {}, now = new Date() } = {}) {
  const { matomo = getPageUrlStats, gsc = getPageSearchDetail } = deps;
  await ensureSnapshotTable();
  const today = localDate(now);

  const { rows: posts } = await pool.query(
    `SELECT DISTINCT ON (url) wp_id, title, url, published_at
       FROM altus_content
      WHERE content_type = 'post' AND url IS NOT NULL
        AND published_at >= NOW() - ($1 || ' days')::interval
      ORDER BY url, published_at DESC`,
    [String(TRACK_DAYS)],
  );
  const { rows: existing } = await pool.query(
    'SELECT url_key, checkpoint_days FROM altus_article_snapshots WHERE url_key = ANY($1)',
    [posts.map((p) => normalizeUrl(p.url))],
  );
  const takenByUrl = new Map();
  for (const r of existing) {
    if (!takenByUrl.has(r.url_key)) takenByUrl.set(r.url_key, new Set());
    takenByUrl.get(r.url_key).add(r.checkpoint_days);
  }

  let taken = 0;
  let skipped = 0;
  for (const post of posts) {
    const key = normalizeUrl(post.url);
    for (const cp of dueCheckpoints(post.published_at, takenByUrl.get(key) ?? new Set(), today)) {
      const [m, g] = await Promise.all([matomo(post.url, cp.start, cp.end), gsc(post.url, cp.start, cp.end)]);
      if (m?.error || g?.error) {
        skipped += 1;
        logger.warn('Article snapshot skipped; will retry', { url: post.url, days: cp.days, matomo: m?.error ?? null, gsc: g?.error ?? null });
        continue;
      }
      await pool.query(
        `INSERT INTO altus_article_snapshots
           (url, url_key, wp_id, title, published_at, checkpoint_days, window_start, window_end, pageviews, visits,
            search_clicks, search_impressions, search_position, news_clicks, news_impressions, top_queries)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (url_key, checkpoint_days) DO NOTHING`,
        [
          post.url, key, post.wp_id, post.title, post.published_at, cp.days, cp.start, cp.end,
          m.pageviews, m.visits, g.search.clicks, g.search.impressions, g.search.position,
          g.news.clicks, g.news.impressions, JSON.stringify(g.top_queries ?? []),
        ],
      );
      taken += 1;
    }
  }
  const summary = { posts: posts.length, taken, skipped };
  logger.info('Article snapshots run complete', summary);
  return summary;
}

/** Share of values ≤ v, 0–100. Pure; exported for tests. */
export function percentileOf(values, v) {
  if (!values.length || v == null) return null;
  return Math.round((values.filter((x) => x <= v).length / values.length) * 100);
}

export function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function toCheckpoint(r, benchmarks) {
  const b = benchmarks.get(r.checkpoint_days);
  return {
    days: r.checkpoint_days,
    window: { start: r.window_start, end: r.window_end },
    pageviews: r.pageviews,
    visits: r.visits,
    search: { clicks: r.search_clicks, impressions: r.search_impressions, position: r.search_position == null ? null : Number(r.search_position) },
    google_news: { clicks: r.news_clicks, impressions: r.news_impressions },
    top_queries: r.top_queries,
    vs_typical: b ? {
      articles_compared: b.pageviews.length,
      median_pageviews: median(b.pageviews),
      pageviews_percentile: percentileOf(b.pageviews, r.pageviews),
      median_search_clicks: median(b.clicks),
      search_clicks_percentile: percentileOf(b.clicks, r.search_clicks),
    } : null,
  };
}

/**
 * Performance for one article (by URL) or for every post published in the
 * last `days` days, each with its checkpoints and a comparison with
 * AltWire's typical article at the same checkpoint.
 */
export async function getArticlePerformance({ url, days = 30 } = {}) {
  await ensureSnapshotTable();
  const { rows: all } = await pool.query('SELECT checkpoint_days, pageviews, search_clicks FROM altus_article_snapshots');
  const benchmarks = new Map();
  for (const r of all) {
    if (!benchmarks.has(r.checkpoint_days)) benchmarks.set(r.checkpoint_days, { pageviews: [], clicks: [] });
    benchmarks.get(r.checkpoint_days).pageviews.push(r.pageviews);
    benchmarks.get(r.checkpoint_days).clicks.push(r.search_clicks);
  }

  const params = [];
  let where;
  if (url) {
    params.push(normalizeUrl(url));
    where = 'lower(rtrim(c.url, \'/\')) = $1';
  } else {
    params.push(String(Math.min(Math.max(Number(days) || 30, 1), 365)));
    where = `c.published_at >= NOW() - ($1 || ' days')::interval`;
  }
  const { rows: posts } = await pool.query(
    `SELECT DISTINCT ON (c.url) c.title, c.url, c.published_at
       FROM altus_content c
      WHERE c.content_type = 'post' AND ${where}
      ORDER BY c.url, c.published_at DESC`,
    params,
  );
  const { rows: snaps } = await pool.query(
    `SELECT *, window_start::text AS window_start, window_end::text AS window_end
       FROM altus_article_snapshots WHERE url_key = ANY($1) ORDER BY checkpoint_days`,
    [posts.map((p) => normalizeUrl(p.url))],
  );
  const byUrl = new Map();
  for (const s of snaps) {
    if (!byUrl.has(s.url_key)) byUrl.set(s.url_key, []);
    byUrl.get(s.url_key).push(s);
  }

  const today = localDate(new Date());
  const articles = posts
    .sort((a, b) => new Date(b.published_at) - new Date(a.published_at))
    .map((p) => {
      const checkpoints = (byUrl.get(normalizeUrl(p.url)) ?? []).map((r) => toCheckpoint(r, benchmarks));
      const takenDays = new Set(checkpoints.map((c) => c.days));
      const next = CHECKPOINTS.map((n) => ({ days: n, start: localDate(p.published_at) }))
        .filter((c) => !takenDays.has(c.days))
        .map((c) => ({ days: c.days, available_on: addDays(addDays(c.start, c.days - 1), GSC_LAG_DAYS) }))
        .filter((c) => c.available_on > today)[0] ?? null;
      return { title: p.title, url: p.url, published_at: p.published_at, checkpoints, next_checkpoint: next };
    });

  return {
    articles,
    count: articles.length,
    note: 'Checkpoints cover the first 3, 7, and 30 days from publication. pageviews and visits are Matomo; search and google_news are Search Console. vs_typical compares with every tracked AltWire article at the same checkpoint (tracking started October 2026, so early comparisons use few articles). For other periods or older articles, use get_altwire_page_performance.',
    ...(url && !articles.length ? { error: `No AltWire post found at ${url}` } : {}),
  };
}

/** Latest snapshot per URL, keyed by normalized URL (for the digest). */
export async function latestSnapshotsByUrl(urls) {
  await ensureSnapshotTable();
  const keys = [...new Set(urls.map(normalizeUrl).filter(Boolean))];
  if (!keys.length) return new Map();
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (url_key) url_key, checkpoint_days, pageviews, search_clicks, search_impressions, news_clicks
       FROM altus_article_snapshots WHERE url_key = ANY($1)
      ORDER BY url_key, checkpoint_days DESC`,
    [keys],
  );
  return new Map(rows.map((r) => [r.url_key, r]));
}
