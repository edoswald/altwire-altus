/**
 * Analytics snapshot for the morning digest and weekly brief.
 *
 * Compares the last N days against the N days before them across Matomo and
 * Google Search Console, and returns the deltas an editor acts on:
 *   - traffic totals + yesterday vs the same weekday last week (Matomo)
 *   - page risers/fallers by pageviews (Matomo)
 *   - search totals and query/page risers/fallers by clicks (GSC)
 *   - queries newly ranking in positions 5–30 (GSC opportunity zone)
 *   - Google News pickup (GSC news search type)
 *   - how articles published in the last 14 days are doing
 *
 * Every source is fetched with Promise.allSettled; a failed source becomes a
 * warning and a null section, never a failed digest.
 */

import pool from '../lib/altus-db.js';
import { logger } from '../logger.js';
import { getTrafficSummary, getTopArticles } from './altwire-matomo-client.js';
import {
  getSearchPerformance,
  getOpportunityZoneQueries,
  getNewsSearchPerformance,
  normalizeUrl,
} from './altwire-gsc-client.js';
import { isoDateOffset } from '../lib/gsc-date-window.js';

// GSC data settles ~2–3 days behind real time.
const GSC_LAG_DAYS = 3;
const RECENT_ARTICLE_DAYS = 14;

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Percent change rounded to one decimal; null when there is no baseline. */
export function pctChange(current, previous) {
  const cur = Number(current);
  const prev = Number(previous);
  if (!Number.isFinite(cur) || !Number.isFinite(prev) || prev === 0) return null;
  return Math.round(((cur - prev) / prev) * 1000) / 10;
}

/** { metric: { current, previous, change_pct } } for each metric present on either side. */
export function compareTotals(current, previous, metrics) {
  if (!current && !previous) return null;
  const out = {};
  for (const metric of metrics) {
    const cur = current?.[metric];
    const prev = previous?.[metric];
    if (cur == null && prev == null) continue;
    out[metric] = {
      current: cur ?? null,
      previous: prev ?? null,
      change_pct: pctChange(cur, prev),
    };
  }
  return out;
}

/**
 * Risers and fallers between two row sets keyed by `keyOf`, ranked by the
 * absolute change in `metric`. Rows below `minVolume` on both sides are
 * ignored so tiny pages don't dominate with huge percentages.
 */
export function computeMovers(currentRows, previousRows, { keyOf, metric, label = () => null, limit = 5, minVolume = 0 } = {}) {
  const merged = new Map();
  for (const [side, rows] of [['current', currentRows], ['previous', previousRows]]) {
    for (const row of Array.isArray(rows) ? rows : []) {
      const key = keyOf(row);
      if (!key) continue;
      const entry = merged.get(key) ?? { key, label: null, current: 0, previous: 0 };
      entry[side] += Number(row[metric]) || 0;
      entry.label = entry.label ?? label(row);
      merged.set(key, entry);
    }
  }

  const deltas = [...merged.values()]
    .filter((e) => Math.max(e.current, e.previous) >= minVolume)
    .map((e) => ({ ...e, change: e.current - e.previous, change_pct: pctChange(e.current, e.previous) }));

  return {
    risers: deltas.filter((e) => e.change > 0).sort((a, b) => b.change - a.change).slice(0, limit),
    fallers: deltas.filter((e) => e.change < 0).sort((a, b) => a.change - b.change).slice(0, limit),
  };
}

/**
 * Queries in the opportunity zone (positions 5–30) now that were not there in
 * the previous window. Rows are GSC [query, page] rows.
 */
export function findNewOpportunityZoneEntries(currentRows, previousRows, limit = 5) {
  const previousQueries = new Set((previousRows ?? []).map((r) => r.keys?.[0]).filter(Boolean));
  const seen = new Set();
  const entries = [];
  for (const row of [...(currentRows ?? [])].sort((a, b) => (b.impressions ?? 0) - (a.impressions ?? 0))) {
    const query = row.keys?.[0];
    if (!query || previousQueries.has(query) || seen.has(query)) continue;
    seen.add(query);
    entries.push({
      query,
      page: row.keys?.[1] ?? null,
      impressions: row.impressions ?? 0,
      clicks: row.clicks ?? 0,
      position: row.position != null ? Math.round(row.position * 10) / 10 : null,
    });
    if (entries.length >= limit) break;
  }
  return entries;
}

/**
 * Join recently published articles with this window's Matomo pageviews, GSC
 * clicks/impressions and their latest tracking snapshot.
 */
export function summarizeRecentArticles(contentRows, { pageviewsByUrl, searchByUrl, snapshotsByUrl }) {
  return (contentRows ?? []).map((row) => {
    const url = normalizeUrl(row.url);
    const search = searchByUrl.get(url);
    const snapshot = snapshotsByUrl.get(url);
    return {
      title: row.title,
      url: row.url,
      published_at: row.published_at instanceof Date ? row.published_at.toISOString() : row.published_at,
      pageviews: pageviewsByUrl.get(url) ?? 0,
      search_clicks: search?.clicks ?? 0,
      search_impressions: search?.impressions ?? 0,
      avg_position: search?.position != null ? Math.round(search.position * 10) / 10 : null,
      latest_snapshot: snapshot
        ? { type: snapshot.snapshot_type, clicks: snapshot.clicks, impressions: snapshot.impressions }
        : null,
    };
  }).sort((a, b) => b.pageviews - a.pageviews);
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

/** YYYY-MM-DD in America/New_York, `daysBack` days before today. Matomo reports in site time. */
function etDate(daysBack) {
  const d = new Date(Date.now() - daysBack * 86400000);
  return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function settledValue(result, warnings, section) {
  if (result.status === 'rejected') {
    warnings.push({ section, message: result.reason?.message || String(result.reason) });
    return null;
  }
  const value = result.value;
  if (value && !Array.isArray(value) && value.error) {
    warnings.push({ section, message: `${value.error}${value.message ? ` — ${value.message}` : ''}` });
    return null;
  }
  return value;
}

const pageRows = (rows) => rows?.pageUrls ?? rows ?? [];

/**
 * Title lookup for archive content. Matomo reports every URL (listing pages,
 * /author/, /page/2, year archives) and marks them all as folders because
 * WordPress URLs end in a slash, so membership in altus_content is what
 * identifies a real article. Returns null if the lookup fails, so callers can
 * fall back to unfiltered rows.
 */
async function lookupArchiveTitles(urls, warnings) {
  const normalized = [...new Set(urls.map((u) => normalizeUrl(u)).filter(Boolean))];
  if (!normalized.length) return new Map();
  try {
    const { rows } = await pool.query(
      `SELECT rtrim(url, '/') AS url, title FROM altus_content WHERE rtrim(url, '/') = ANY($1)`,
      [normalized],
    );
    return new Map(rows.map((r) => [r.url, r.title]));
  } catch (err) {
    warnings.push({ section: 'archive_titles', message: err.message });
    return null;
  }
}

/**
 * Build the analytics snapshot comparing the last `days` days with the
 * `days` days before them.
 *
 * @param {{ days?: number }} [options]
 * @returns {Promise<object>}
 */
export async function buildAnalyticsSnapshot({ days = 7 } = {}) {
  const warnings = [];

  const matomoCurrent = `${etDate(days)},${etDate(1)}`;
  const matomoPrevious = `${etDate(days * 2)},${etDate(days + 1)}`;
  const gscCurrent = [isoDateOffset(GSC_LAG_DAYS + days - 1), isoDateOffset(GSC_LAG_DAYS)];
  const gscPrevious = [isoDateOffset(GSC_LAG_DAYS + days * 2 - 1), isoDateOffset(GSC_LAG_DAYS + days)];

  const results = await Promise.allSettled([
    getTrafficSummary('range', matomoCurrent),
    getTrafficSummary('range', matomoPrevious),
    getTrafficSummary('day', etDate(1)),
    getTrafficSummary('day', etDate(8)),
    getTopArticles('range', matomoCurrent, 100),
    getTopArticles('range', matomoPrevious, 100),
    getSearchPerformance(...gscCurrent, { dimensions: [], rowLimit: 1 }),
    getSearchPerformance(...gscPrevious, { dimensions: [], rowLimit: 1 }),
    getSearchPerformance(...gscCurrent, { dimensions: ['query'], rowLimit: 250 }),
    getSearchPerformance(...gscPrevious, { dimensions: ['query'], rowLimit: 250 }),
    getSearchPerformance(...gscCurrent, { dimensions: ['page'], rowLimit: 500 }),
    getSearchPerformance(...gscPrevious, { dimensions: ['page'], rowLimit: 500 }),
    getOpportunityZoneQueries(...gscCurrent),
    getOpportunityZoneQueries(...gscPrevious),
    getNewsSearchPerformance(...gscCurrent, { dimensions: ['page'], rowLimit: 50 }),
    pool.query(
      `SELECT title, url, published_at FROM altus_content
        WHERE content_type = 'post' AND published_at >= NOW() - INTERVAL '${RECENT_ARTICLE_DAYS} days'
        ORDER BY published_at DESC LIMIT 25`,
    ),
  ]);

  const [
    trafficCur, trafficPrev, yesterday, sameDayLastWeek,
    pagesCur, pagesPrev,
    gscTotalCur, gscTotalPrev, queriesCur, queriesPrev, gscPagesCur, gscPagesPrev,
    oppZoneCur, oppZonePrev, news, recentContent,
  ] = [
    settledValue(results[0], warnings, 'matomo_traffic'),
    settledValue(results[1], warnings, 'matomo_traffic_previous'),
    settledValue(results[2], warnings, 'matomo_yesterday'),
    settledValue(results[3], warnings, 'matomo_same_day_last_week'),
    settledValue(results[4], warnings, 'matomo_pages'),
    settledValue(results[5], warnings, 'matomo_pages_previous'),
    settledValue(results[6], warnings, 'gsc_totals'),
    settledValue(results[7], warnings, 'gsc_totals_previous'),
    settledValue(results[8], warnings, 'gsc_queries'),
    settledValue(results[9], warnings, 'gsc_queries_previous'),
    settledValue(results[10], warnings, 'gsc_pages'),
    settledValue(results[11], warnings, 'gsc_pages_previous'),
    settledValue(results[12], warnings, 'gsc_opportunity_zone'),
    settledValue(results[13], warnings, 'gsc_opportunity_zone_previous'),
    settledValue(results[14], warnings, 'gsc_news'),
    settledValue(results[15], warnings, 'recent_articles'),
  ];

  const TRAFFIC_METRICS = ['nb_visits', 'nb_uniq_visitors', 'nb_pageviews', 'bounce_rate'];
  const traffic = compareTotals(trafficCur, trafficPrev, TRAFFIC_METRICS);
  const yesterdayVsLastWeek = compareTotals(yesterday, sameDayLastWeek, TRAFFIC_METRICS);

  const titles = await lookupArchiveTitles([
    ...pageRows(pagesCur).map((r) => r.url),
    ...pageRows(pagesPrev).map((r) => r.url),
    ...(gscPagesCur?.rows ?? []).map((r) => r.keys?.[0]),
    ...(gscPagesPrev?.rows ?? []).map((r) => r.keys?.[0]),
    ...(news?.rows ?? []).map((r) => r.keys?.[0]),
  ], warnings);
  const titleOf = (url) => titles?.get(normalizeUrl(url)) ?? null;
  const articlesOnly = (rows) => (titles ? pageRows(rows).filter((r) => titles.has(normalizeUrl(r.url))) : pageRows(rows));

  const page_movers = (pagesCur || pagesPrev)
    ? computeMovers(articlesOnly(pagesCur), articlesOnly(pagesPrev), {
      keyOf: (r) => normalizeUrl(r.url),
      label: (r) => titleOf(r.url) ?? r.label ?? null,
      metric: 'nb_hits',
      minVolume: 20,
    })
    : null;

  const top_pages = articlesOnly(pagesCur)
    .sort((a, b) => (b.nb_hits ?? 0) - (a.nb_hits ?? 0))
    .slice(0, 5)
    .map((r) => ({ url: r.url, label: titleOf(r.url) ?? r.label, pageviews: r.nb_hits ?? 0 }));

  const totalRow = (r) => (r?.rows?.[0] ? { clicks: r.rows[0].clicks, impressions: r.rows[0].impressions, ctr: r.rows[0].ctr, position: r.rows[0].position } : null);
  const search = {
    totals: compareTotals(totalRow(gscTotalCur), totalRow(gscTotalPrev), ['clicks', 'impressions', 'ctr', 'position']),
    query_movers: (queriesCur || queriesPrev)
      ? computeMovers(queriesCur?.rows, queriesPrev?.rows, { keyOf: (r) => r.keys?.[0], metric: 'clicks', minVolume: 5 })
      : null,
    page_movers: (gscPagesCur || gscPagesPrev)
      ? computeMovers(gscPagesCur?.rows, gscPagesPrev?.rows, { keyOf: (r) => normalizeUrl(r.keys?.[0]), label: (r) => titleOf(r.keys?.[0]), metric: 'clicks', minVolume: 5 })
      : null,
  };

  const opportunity_zone_new = (oppZoneCur && oppZonePrev)
    ? findNewOpportunityZoneEntries(oppZoneCur.rows, oppZonePrev.rows)
    : null;

  let google_news = null;
  if (news) {
    const rows = news.rows ?? [];
    google_news = {
      total_clicks: rows.reduce((sum, r) => sum + (r.clicks ?? 0), 0),
      total_impressions: rows.reduce((sum, r) => sum + (r.impressions ?? 0), 0),
      top_pages: rows.slice(0, 5).map((r) => ({ url: r.keys?.[0], title: titleOf(r.keys?.[0]), clicks: r.clicks ?? 0, impressions: r.impressions ?? 0 })),
    };
  }

  let recent_articles = null;
  if (recentContent) {
    const contentRows = recentContent.rows ?? [];
    const urls = contentRows.map((r) => r.url).filter(Boolean);
    let snapshotRows = [];
    if (urls.length) {
      try {
        ({ rows: snapshotRows } = await pool.query(
          `SELECT DISTINCT ON (article_url) article_url, snapshot_type, clicks, impressions
             FROM altus_article_performance
            WHERE article_url = ANY($1)
            ORDER BY article_url, snapshot_taken_at DESC`,
          [urls],
        ));
      } catch (err) {
        warnings.push({ section: 'article_snapshots', message: err.message });
      }
    }
    recent_articles = summarizeRecentArticles(contentRows, {
      pageviewsByUrl: new Map(pageRows(pagesCur).map((r) => [normalizeUrl(r.url), r.nb_hits ?? 0])),
      searchByUrl: new Map((gscPagesCur?.rows ?? []).map((r) => [normalizeUrl(r.keys?.[0]), r])),
      snapshotsByUrl: new Map(snapshotRows.map((r) => [normalizeUrl(r.article_url), r])),
    });
  }

  logger.info('Digest analytics snapshot built', { days, warnings: warnings.length });

  return {
    days,
    windows: {
      matomo: { current: matomoCurrent, previous: matomoPrevious },
      gsc: { current: gscCurrent, previous: gscPrevious },
    },
    traffic,
    yesterday_vs_last_week: yesterdayVsLastWeek,
    top_pages,
    page_movers,
    search,
    opportunity_zone_new,
    google_news,
    recent_articles,
    warnings,
  };
}
