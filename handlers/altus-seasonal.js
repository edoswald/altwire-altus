/**
 * Seasonal look-back: how AltWire did over a past season (default: last
 * year's November–December holiday season) in Google Search Console and
 * Matomo, joined with how the same pages are doing now.
 *
 * Answers "which holiday/gift queries and pages worked last year, and which
 * of those pages are worth refreshing before this season?"
 *
 * GSC keeps roughly 16 months of data, so only the most recent season is
 * available there; Matomo goes back further.
 */

import pool from '../lib/altus-db.js';
import { getLagAwareGscWindow } from '../lib/gsc-date-window.js';
import { normalizeTopArticles } from '../lib/matomo-utils.js';
import { getSearchPerformance } from './altwire-gsc-client.js';
import { getTopArticles } from './altwire-matomo-client.js';

const BASE_URL = 'https://altwire.net';
const GSC_RETENTION_DAYS = 480; // ~16 months, minus a little margin

export const SEASONAL_TERMS = /gift|holiday|christmas|xmas|hanukkah|stocking|black friday|cyber monday|deals?\b|wish ?list|under \$?\d+|best .*\b20\d\d\b|\b20\d\d\b.*\bbest\b|year[- ]end|end of (the )?year/i;

const MD_RE = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

const normalizeUrl = (u) => (typeof u === 'string' ? u.replace(/\/+$/, '').toLowerCase() : null);
const round = (n, d = 1) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null);

/**
 * Resolve the season window. Without a year, picks the most recent season
 * that has already ended. A window whose end is before its start (e.g.
 * 12-15 → 01-10) runs into the next year.
 */
export function resolveSeasonWindow({ year, start_md: startMd = '11-01', end_md: endMd = '12-31' } = {}, now = new Date()) {
  if (!MD_RE.test(startMd) || !MD_RE.test(endMd)) {
    throw new Error('start_md and end_md must be MM-DD, e.g. 11-01');
  }
  const wraps = endMd < startMd;
  const build = (y) => ({
    startDate: `${y}-${startMd}`,
    endDate: `${wraps ? y + 1 : y}-${endMd}`,
  });
  if (year) return { year, ...build(year) };

  const today = now.toISOString().slice(0, 10);
  let y = now.getUTCFullYear();
  while (build(y).endDate >= today) y -= 1;
  return { year: y, ...build(y) };
}

function daysBetween(a, b) {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
}

async function lookupArticles(urls) {
  const normalized = [...new Set(urls.map((u) => (typeof u === 'string' ? u.replace(/\/+$/, '') : null)).filter(Boolean))];
  if (!normalized.length) return new Map();
  const { rows } = await pool.query(
    `SELECT lower(rtrim(url, '/')) AS url, title, published_at, categories
       FROM altus_content WHERE rtrim(url, '/') = ANY($1)`,
    [normalized],
  );
  return new Map(rows.map((r) => [r.url, r]));
}

/**
 * Join season GSC/Matomo rows with current GSC rows and archive metadata.
 * Pure; exported for tests.
 */
export function buildSeasonalReport({
  window,
  seasonQueries = [],
  seasonPages = [],
  seasonArticles = [],
  currentPages = [],
  articles = new Map(),
  queryContains = null,
  limit = 25,
}) {
  const matchesFilter = (text) => !queryContains || String(text).toLowerCase().includes(queryContains.toLowerCase());

  const queries = seasonQueries
    .map((r) => ({
      query: r.keys?.[0],
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: round((r.ctr ?? 0) * 100),
      position: round(r.position),
      seasonal: SEASONAL_TERMS.test(r.keys?.[0] ?? ''),
    }))
    .filter((q) => q.query && matchesFilter(q.query));

  const current = new Map(currentPages.map((r) => [normalizeUrl(r.keys?.[0]), r]));
  const pageviews = new Map(seasonArticles.map((a) => [normalizeUrl(a.url), a.pageviews]));

  const pages = new Map();
  for (const r of seasonPages) {
    const url = r.keys?.[0];
    const key = normalizeUrl(url);
    if (!key) continue;
    pages.set(key, {
      url,
      season_clicks: r.clicks,
      season_impressions: r.impressions,
      season_position: round(r.position),
    });
  }
  for (const a of seasonArticles) {
    const key = normalizeUrl(a.url);
    if (!key) continue;
    if (!pages.has(key)) pages.set(key, { url: a.url, season_clicks: null, season_impressions: null, season_position: null });
  }

  const rows = [...pages.entries()].map(([key, p]) => {
    const article = articles.get(key);
    const now = current.get(key);
    const title = article?.title ?? null;
    const seasonPageviews = pageviews.get(key) ?? null;
    const row = {
      ...p,
      title,
      is_article: Boolean(article),
      published_at: article?.published_at ?? null,
      season_pageviews: seasonPageviews,
      seasonal: SEASONAL_TERMS.test(`${title ?? ''} ${p.url}`),
      last_28d_clicks: now ? now.clicks : 0,
      last_28d_position: now ? round(now.position) : null,
    };
    // Worth refreshing: a real article that earned meaningful traffic last
    // season. The agent decides; this just narrows the list.
    row.refresh_candidate = row.is_article
      && ((row.season_clicks ?? 0) >= 10 || (row.season_pageviews ?? 0) >= 100);
    return row;
  });

  const byTraffic = (a, b) => ((b.season_clicks ?? 0) + (b.season_pageviews ?? 0) / 10)
    - ((a.season_clicks ?? 0) + (a.season_pageviews ?? 0) / 10);
  const pageRows = rows
    .filter((r) => matchesFilter(`${r.title ?? ''} ${r.url}`))
    .sort(byTraffic);

  return {
    window,
    top_queries: queries.slice(0, limit),
    seasonal_queries: queries.filter((q) => q.seasonal).sort((a, b) => b.impressions - a.impressions).slice(0, limit),
    top_pages: pageRows.filter((r) => r.is_article).slice(0, limit),
    seasonal_pages: pageRows.filter((r) => r.seasonal).slice(0, limit),
    refresh_candidates: pageRows.filter((r) => r.refresh_candidate && r.seasonal).slice(0, limit),
  };
}

/**
 * @param {object} [opts]
 * @param {number} [opts.year]           Season year (default: the most recent completed season)
 * @param {string} [opts.start_md]       MM-DD (default 11-01)
 * @param {string} [opts.end_md]         MM-DD (default 12-31)
 * @param {string} [opts.query_contains] Only queries/pages containing this text
 * @param {number} [opts.limit]          Rows per list (default 25)
 */
export async function getSeasonalComparison(opts = {}, deps = {}) {
  const {
    gsc = getSearchPerformance,
    matomoTopArticles = getTopArticles,
    articleLookup = lookupArticles,
    now = new Date(),
  } = deps;
  const limit = Math.min(Math.max(Number(opts.limit) || 25, 5), 100);
  const window = resolveSeasonWindow(opts, now);
  const notes = [];

  // GSC only keeps ~16 months; clamp or skip.
  const today = now.toISOString().slice(0, 10);
  const age = daysBetween(window.startDate, today);
  let gscWindow = { startDate: window.startDate, endDate: window.endDate };
  let gscAvailable = true;
  if (daysBetween(window.endDate, today) > GSC_RETENTION_DAYS) {
    gscAvailable = false;
    notes.push('Search Console keeps about 16 months of data, so this season has no search data; only Matomo pageviews are shown.');
  } else if (age > GSC_RETENTION_DAYS) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - GSC_RETENTION_DAYS);
    gscWindow = { ...gscWindow, startDate: d.toISOString().slice(0, 10) };
    notes.push(`Search Console data starts ${gscWindow.startDate} (16-month limit); earlier days of the season are missing from search figures.`);
  }

  const current = getLagAwareGscWindow(28);
  const empty = { rows: [] };
  const [seasonQueries, seasonPages, currentPages, seasonArticlesRaw] = await Promise.all([
    gscAvailable ? gsc(gscWindow.startDate, gscWindow.endDate, { rowLimit: 1000, dimensions: ['query'] }) : empty,
    gscAvailable ? gsc(gscWindow.startDate, gscWindow.endDate, { rowLimit: 500, dimensions: ['page'] }) : empty,
    gsc(current.startDate, current.endDate, { rowLimit: 1000, dimensions: ['page'] }),
    matomoTopArticles('range', `${window.startDate},${window.endDate}`, 300),
  ]);

  for (const [label, r] of [['Search Console (season queries)', seasonQueries], ['Search Console (season pages)', seasonPages], ['Search Console (last 28 days)', currentPages], ['Matomo', seasonArticlesRaw]]) {
    if (r?.error) notes.push(`${label} unavailable: ${r.message ?? r.error}`);
  }

  const seasonArticles = normalizeTopArticles(Array.isArray(seasonArticlesRaw) ? seasonArticlesRaw : [], BASE_URL);
  const pageUrls = [
    ...(seasonPages.rows ?? []).map((r) => r.keys?.[0]),
    ...seasonArticles.map((a) => a.url),
  ];
  let articles = new Map();
  try {
    articles = await articleLookup(pageUrls);
  } catch (err) {
    notes.push(`Archive lookup failed (${err.message}); titles and publish dates are missing.`);
  }

  const report = buildSeasonalReport({
    window: { ...window, gsc_start_date: gscAvailable ? gscWindow.startDate : null, current_window: current },
    seasonQueries: seasonQueries.rows ?? [],
    seasonPages: seasonPages.rows ?? [],
    seasonArticles,
    currentPages: currentPages.rows ?? [],
    articles,
    queryContains: opts.query_contains ?? null,
    limit,
  });
  return { ...report, notes };
}
