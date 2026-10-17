/**
 * AltWire's traffic patterns: what a normal day looks like, when and why
 * traffic spikes, how fast spikes and articles fade, and how much traffic
 * the back catalog earns.
 *
 * Daily data is stored in two tables and kept current by the nightly
 * analytics job:
 *   altus_daily_site  one row per day: Matomo visits, pageviews and referrer
 *                     types; Google web clicks and impressions (property
 *                     totals); Google News and Discover clicks.
 *   altus_daily_page  one row per day per page: Matomo pageviews and visits
 *                     (Matomo's top 500 pages per day) and Google web, News
 *                     and Discover clicks (every page with data).
 * The first run backfills about 13 months of Matomo and 16 months of Search
 * Console; later runs refresh the last few days.
 *
 * The analysis is deterministic (no model) and covers the last 12 months
 * only: AltWire was barely optimized for years before that, so older data
 * describes a different site. It is stored as one JSON document in altus_kv.
 */

import pool from '../lib/altus-db.js';
import { logger } from '../logger.js';
import { ensureKvTable } from './altus-history.js';
import { getDailyPageSearch, getDailySearchTotals, getSearchPerformance } from './altwire-gsc-client.js';
import { getDailyPageViews, getDailySiteTotals } from './altwire-matomo-client.js';

export const PATTERNS_KEY = 'analytics:traffic_patterns';
const BACKFILL_KEY = 'traffic:daily_backfill';
const TIME_ZONE = 'America/New_York';
const GSC_LAG_DAYS = 3;
const MATOMO_BACKFILL_DAYS = 400;
const GSC_BACKFILL_DAYS = 480;
const REFRESH_DAYS = 10;
const CHUNK_DAYS = 31;

export const ANALYSIS_DAYS = 365;
export const SPIKE_THRESHOLD = 1.5;
export const BACK_TO_NORMAL = 1.15;
export const FRESH_DAYS = 7;
const BASELINE_WINDOW = 28;
const MIN_BASELINE_DAYS = 14;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// ------------------------------------------------------------------ helpers

/** One key per article however a source writes its URL. */
export function urlKey(url) {
  if (typeof url !== 'string' || !url) return null;
  return url.trim().toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[?#].*$/, '')
    .replace(/\/(index|amp)$/, '')
    .replace(/\/+$/, '');
}

export function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400000);
}

function localDate(instant) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(instant));
}

export function median(values) {
  const s = values.filter((v) => v != null && Number.isFinite(v)).sort((a, b) => a - b);
  if (!s.length) return null;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const round = (v, places = 0) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** places) / 10 ** places);
const pct = (part, whole) => (whole > 0 ? round((part / whole) * 100) : null);
const weekday = (isoDate) => new Date(`${isoDate}T12:00:00Z`).getUTCDay();

/** Rough article type from WordPress categories, tags and title. */
export function articleKind({ title = '', categories = [], tags = [], content_type: contentType } = {}) {
  if (contentType === 'gallery') return 'live';
  const terms = [...(categories ?? []), ...(tags ?? [])].join(' ').toLowerCase();
  const t = String(title ?? '').toLowerCase();
  if (/interview/.test(terms) || /\binterview\b|\bq&a\b|\btalks\b/.test(t)) return 'interview';
  if (/review/.test(terms) || /\breview\b/.test(t)) return 'review';
  if (/photo|gallery|live/.test(terms) || /\bphotos?\b|\blive (at|in)\b|\bin concert\b/.test(t)) return 'live';
  if (/news/.test(terms)) return 'news';
  if (/feature|guide|list|best of/.test(terms) || /\bbest\b|\bguide\b|\btop \d+\b/.test(t)) return 'feature';
  return 'other';
}

export const KIND_LABELS = { review: 'reviews', interview: 'interviews', news: 'news', live: 'live coverage and photos', feature: 'features and lists', other: 'other articles' };

/** Which age group a page falls in on a given day. */
export function ageBucket(ageDays) {
  if (ageDays == null) return 'not_article';
  if (ageDays < FRESH_DAYS) return 'fresh';
  if (ageDays < 30) return 'recent';
  if (ageDays < 365) return 'this_year';
  return 'archive';
}

// ------------------------------------------------------------------ storage

export async function ensureTrafficTables(client = pool) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS altus_daily_site (
      date             DATE PRIMARY KEY,
      visits           INTEGER,
      pageviews        INTEGER,
      ref_search       INTEGER,
      ref_social       INTEGER,
      ref_direct       INTEGER,
      ref_websites     INTEGER,
      ref_other        INTEGER,
      web_clicks       INTEGER,
      web_impressions  INTEGER,
      news_clicks      INTEGER,
      discover_clicks  INTEGER,
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS altus_daily_page (
      date             DATE NOT NULL,
      url_key          TEXT NOT NULL,
      pageviews        INTEGER,
      visits           INTEGER,
      web_clicks       INTEGER,
      web_impressions  INTEGER,
      news_clicks      INTEGER,
      discover_clicks  INTEGER,
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (date, url_key)
    )
  `);
}

async function upsert(table, keyCols, cols, rows) {
  const all = [...keyCols, ...cols];
  for (let i = 0; i < rows.length; i += 500) {
    const params = [];
    const values = rows.slice(i, i + 500).map((r) => `(${all.map((c) => { params.push(r[c] ?? null); return `$${params.length}`; }).join(',')})`);
    await pool.query(
      `INSERT INTO ${table} (${all.join(', ')}) VALUES ${values.join(', ')}
       ON CONFLICT (${keyCols.join(', ')}) DO UPDATE SET ${cols.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}, updated_at = NOW()`,
      params,
    );
  }
}

/** Sum rows that share a date and URL key (http/https, ?query, /amp variants). */
export function mergeByPage(rows, fields) {
  const map = new Map();
  for (const r of rows) {
    const key = urlKey(r.url ?? r.page);
    if (!key) continue;
    const id = `${r.date}|${key}`;
    if (!map.has(id)) map.set(id, { date: r.date, url_key: key, ...Object.fromEntries(Object.values(fields).map((f) => [f, 0])) });
    const m = map.get(id);
    for (const [from, to] of Object.entries(fields)) m[to] += r[from] ?? 0;
  }
  return [...map.values()];
}

function chunks(start, end) {
  const out = [];
  for (let s = start; s <= end; s = addDays(s, CHUNK_DAYS)) {
    const e = addDays(s, CHUNK_DAYS - 1);
    out.push([s, e < end ? e : end]);
  }
  return out;
}

async function kvGet(key) {
  await ensureKvTable();
  const { rows } = await pool.query('SELECT value, computed_at FROM altus_kv WHERE key = $1', [key]);
  return rows[0] ?? null;
}

async function kvSet(key, value) {
  await ensureKvTable();
  const { rows } = await pool.query(
    `INSERT INTO altus_kv (key, value, computed_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at
     RETURNING computed_at`,
    [key, JSON.stringify(value)],
  );
  return rows[0].computed_at;
}

async function syncMatomo(start, end, deps) {
  for (const [s, e] of chunks(start, end)) {
    const site = await deps.matomoSite(s, e);
    if (site?.error) return `Matomo ${s}–${e}: ${site.message ?? site.error}`;
    await upsert('altus_daily_site', ['date'], ['visits', 'pageviews', 'ref_search', 'ref_social', 'ref_direct', 'ref_websites', 'ref_other'],
      Object.entries(site).map(([date, d]) => ({
        date, visits: d.visits, pageviews: d.pageviews,
        ref_search: d.referrers.search, ref_social: d.referrers.social, ref_direct: d.referrers.direct,
        ref_websites: d.referrers.websites, ref_other: d.referrers.other,
      })));
    const pages = await deps.matomoPages(s, e);
    if (pages?.error) return `Matomo pages ${s}–${e}: ${pages.message ?? pages.error}`;
    await upsert('altus_daily_page', ['date', 'url_key'], ['pageviews', 'visits'], mergeByPage(pages.rows, { pageviews: 'pageviews', visits: 'visits' }));
  }
  return null;
}

async function syncSearch(start, end, deps) {
  const totals = await deps.gscTotals(start, end);
  if (totals?.error) return `Search Console totals: ${totals.message ?? totals.error}`;
  await upsert('altus_daily_site', ['date'], ['web_clicks', 'web_impressions'],
    totals.rows.map((r) => ({ date: r.date, web_clicks: r.clicks, web_impressions: r.impressions })));

  for (const [s, e] of chunks(start, end)) {
    const [web, news, discover] = await Promise.all([
      deps.gscPages(s, e, { searchType: 'web' }),
      deps.gscPages(s, e, { searchType: 'news' }),
      deps.gscPages(s, e, { searchType: 'discover' }),
    ]);
    const failed = [web, news, discover].find((r) => r?.error);
    if (failed) return `Search Console pages ${s}–${e}: ${failed.message ?? failed.error}`;
    await upsert('altus_daily_page', ['date', 'url_key'], ['web_clicks', 'web_impressions'], mergeByPage(web.rows, { clicks: 'web_clicks', impressions: 'web_impressions' }));
    const newsRows = mergeByPage(news.rows, { clicks: 'news_clicks' });
    const discoverRows = mergeByPage(discover.rows, { clicks: 'discover_clicks' });
    await upsert('altus_daily_page', ['date', 'url_key'], ['news_clicks'], newsRows);
    await upsert('altus_daily_page', ['date', 'url_key'], ['discover_clicks'], discoverRows);
    const byDate = new Map();
    for (const r of newsRows) byDate.set(r.date, { ...(byDate.get(r.date) ?? { news_clicks: 0, discover_clicks: 0 }), news_clicks: (byDate.get(r.date)?.news_clicks ?? 0) + r.news_clicks });
    for (const r of discoverRows) byDate.set(r.date, { ...(byDate.get(r.date) ?? { news_clicks: 0, discover_clicks: 0 }), discover_clicks: (byDate.get(r.date)?.discover_clicks ?? 0) + r.discover_clicks });
    const days = [];
    for (let d = s; d <= e; d = addDays(d, 1)) days.push({ date: d, ...(byDate.get(d) ?? { news_clicks: 0, discover_clicks: 0 }) });
    await upsert('altus_daily_site', ['date'], ['news_clicks', 'discover_clicks'], days);
  }
  return null;
}

/**
 * Bring the daily tables up to date: a full backfill the first time, then
 * the last REFRESH_DAYS days (Search Console revises recent days).
 */
export async function syncDailyTraffic({ deps = {}, now = new Date() } = {}) {
  const d = {
    matomoSite: getDailySiteTotals, matomoPages: getDailyPageViews,
    gscTotals: getDailySearchTotals, gscPages: getDailyPageSearch, ...deps,
  };
  await ensureTrafficTables();
  const today = localDate(now);
  const yesterday = addDays(today, -1);
  const gscEnd = addDays(today, -GSC_LAG_DAYS);
  const backfilled = await kvGet(BACKFILL_KEY);
  const matomoStart = addDays(today, backfilled ? -REFRESH_DAYS : -MATOMO_BACKFILL_DAYS);
  const gscStart = addDays(today, backfilled ? -REFRESH_DAYS - GSC_LAG_DAYS : -GSC_BACKFILL_DAYS);

  const errors = [await syncMatomo(matomoStart, yesterday, d), await syncSearch(gscStart, gscEnd, d)].filter(Boolean);
  if (errors.length) {
    logger.warn('Daily traffic sync incomplete', { errors, backfill: !backfilled });
    return { error: errors.join('; '), backfill: !backfilled };
  }
  if (!backfilled) await kvSet(BACKFILL_KEY, { matomo_from: matomoStart, search_from: gscStart, done: today });
  logger.info('Daily traffic synced', { backfill: !backfilled, matomo_from: matomoStart, search_from: gscStart });
  return { backfill: !backfilled, matomo: [matomoStart, yesterday], search: [gscStart, gscEnd] };
}

// ------------------------------------------------------------------ analysis

/**
 * Expected visits for each day and whether it is a spike. The baseline is
 * the median of the previous 28 non-spike days, scaled by that weekday's
 * usual level; spike days never feed later baselines, so one viral week
 * doesn't raise "normal". Pure; exported for tests.
 *
 * @param {{ date: string, value: number }[]} series  ascending, one per day
 * @returns {{ date, value, expected, ratio, spike }[]} plus weekday factors
 */
export function markSpikes(series, { threshold = SPIKE_THRESHOLD, window = BASELINE_WINDOW } = {}) {
  const pass = (factors) => {
    const normal = [];
    return series.map((d) => {
      const base = normal.length >= MIN_BASELINE_DAYS ? median(normal.slice(-window)) : null;
      const expected = base == null ? null : base * (factors?.[weekday(d.date)] ?? 1);
      const spike = expected != null && expected > 0 && d.value >= expected * threshold && d.value - expected >= Math.max(20, expected * 0.25);
      if (!spike) normal.push(factors ? d.value / (factors[weekday(d.date)] ?? 1) : d.value);
      return { date: d.date, value: d.value, expected, ratio: expected ? d.value / expected : null, spike };
    });
  };
  const first = pass(null);
  const byDay = Array.from({ length: 7 }, () => []);
  for (const d of first) if (!d.spike && d.expected) byDay[weekday(d.date)].push(d.value / d.expected);
  const raw = byDay.map((r) => median(r) ?? 1);
  const mean = raw.reduce((s, v) => s + v, 0) / 7;
  const factors = raw.map((v) => v / mean);
  return { days: pass(factors), weekdayFactors: factors };
}

/** Group consecutive spike days into episodes and measure how they faded. */
export function findEpisodes(days) {
  const episodes = [];
  for (let i = 0; i < days.length; i += 1) {
    if (!days[i].spike) continue;
    let j = i;
    while (j + 1 < days.length && days[j + 1].spike) j += 1;
    const span = days.slice(i, j + 1);
    const peak = span.reduce((a, b) => (b.ratio > a.ratio ? b : a));
    const peakIdx = days.indexOf(peak);
    let back = null;
    for (let k = peakIdx + 1; k < days.length; k += 1) {
      if (days[k].expected && days[k].value <= days[k].expected * BACK_TO_NORMAL) { back = k - peakIdx; break; }
    }
    episodes.push({
      start: days[i].date,
      end: days[j].date,
      peak_date: peak.date,
      peak_visits: peak.value,
      expected_at_peak: round(peak.expected),
      peak_multiple: round(peak.ratio, 1),
      days_elevated: j - i + 1,
      days_peak_to_normal: back,
      ongoing: j === days.length - 1,
      extra_visits: round(span.reduce((s, d) => s + (d.value - d.expected), 0)),
    });
    i = j;
  }
  return episodes;
}

function indexPages(pages) {
  const byKey = new Map();
  const byDate = new Map();
  for (const p of pages) {
    if (!byKey.has(p.url_key)) byKey.set(p.url_key, new Map());
    byKey.get(p.url_key).set(p.date, p);
    if (!byDate.has(p.date)) byDate.set(p.date, []);
    byDate.get(p.date).push(p);
  }
  return { byKey, byDate };
}

function describePost(post, onDate) {
  if (!post) return null;
  const age = daysBetween(post.published, onDate);
  return { title: post.title, url: post.url, kind: post.kind, published: post.published, age_days: age, fresh: age < FRESH_DAYS };
}

/** The pages that gained the most views during an episode, vs their prior two weeks. */
function spikeDrivers(episode, index, postsByKey, { limit = 3 } = {}) {
  const dates = [];
  for (let d = episode.start; d <= episode.end; d = addDays(d, 1)) dates.push(d);
  const candidates = new Set(dates.flatMap((d) => (index.byDate.get(d) ?? []).map((p) => p.url_key)));
  const gains = [...candidates].map((key) => {
    const series = index.byKey.get(key);
    const during = dates.reduce((s, d) => s + (series.get(d)?.pageviews ?? 0), 0);
    const before = [];
    for (let k = 1; k <= 14; k += 1) before.push(series.get(addDays(episode.start, -k))?.pageviews ?? 0);
    return { key, during, gain: during - (median(before) ?? 0) * dates.length };
  }).filter((g) => g.gain > 0).sort((a, b) => b.gain - a.gain);
  const totalGain = gains.reduce((s, g) => s + g.gain, 0);
  return gains.slice(0, limit).map((g) => ({
    ...(describePost(postsByKey.get(g.key), episode.start) ?? { page: g.key, kind: 'not an article' }),
    extra_pageviews: round(g.gain),
    share_of_gain_pct: pct(g.gain, totalGain),
  }));
}

function sourceShift(episode, siteByDate, dates) {
  const sum = (field, list) => list.reduce((s, d) => s + (siteByDate.get(d)?.[field] ?? 0), 0);
  const during = [];
  for (let d = episode.start; d <= episode.end; d = addDays(d, 1)) during.push(d);
  const before = dates.filter((d) => d < episode.start).slice(-28);
  const n = during.length;
  const shift = {};
  for (const [label, field] of [['google_search', 'web_clicks'], ['google_news', 'news_clicks'], ['google_discover', 'discover_clicks'],
    ['search_engines', 'ref_search'], ['social', 'ref_social'], ['direct', 'ref_direct'], ['other_websites', 'ref_websites']]) {
    if (during.some((d) => siteByDate.get(d)?.[field] == null)) continue;
    const normal = median(before.map((d) => siteByDate.get(d)?.[field] ?? null)) ?? 0;
    shift[label] = round(sum(field, during) - normal * n);
  }
  const google = ['google_search', 'google_news', 'google_discover'].filter((k) => k in shift);
  const referrers = ['search_engines', 'social', 'direct', 'other_websites'].filter((k) => k in shift);
  const top = (keys) => keys.reduce((a, k) => (a == null || shift[k] > shift[a] ? k : a), null);
  return { extra_by_source: shift, main_google_source: top(google), main_referrer: top(referrers) };
}

function mixFor(dates, index, postsByKey, siteByDate, field, { untracked = false } = {}) {
  const totals = { fresh: 0, recent: 0, this_year: 0, archive: 0, not_article: 0 };
  let siteTotal = 0;
  for (const d of dates) {
    for (const p of index.byDate.get(d) ?? []) {
      const post = postsByKey.get(p.url_key);
      totals[ageBucket(post ? daysBetween(post.published, d) : null)] += p[field] ?? 0;
    }
    siteTotal += siteByDate.get(d)?.pageviews ?? 0;
  }
  const tracked = Object.values(totals).reduce((s, v) => s + v, 0);
  const whole = untracked ? Math.max(siteTotal, tracked) : tracked;
  const out = Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, pct(v, whole)]));
  if (untracked) out.smaller_pages = pct(whole - tracked, whole);
  return out;
}

/** How a typical article's traffic fades, by kind. */
function articleDecay(posts, index, windowStart, lastDate) {
  const rows = [];
  for (const post of posts) {
    if (post.published < windowStart || daysBetween(post.published, lastDate) < 30) continue;
    const series = index.byKey.get(post.key);
    const views = Array.from({ length: 90 }, (_, d) => series?.get(addDays(post.published, d))?.pageviews ?? 0);
    const clicks = Array.from({ length: 30 }, (_, d) => series?.get(addDays(post.published, d))?.web_clicks ?? 0);
    const first30 = views.slice(0, 30).reduce((s, v) => s + v, 0);
    const firstClick = clicks.findIndex((c) => c > 0);
    const row = { kind: post.kind, first30, first_click_day: firstClick < 0 ? null : firstClick };
    if (first30 >= 30) {
      let cum = 0;
      for (let d = 0; d < 30; d += 1) {
        cum += views[d];
        if (row.half_day == null && cum >= first30 / 2) row.half_day = d + 1;
        if (row.ninety_day == null && cum >= first30 * 0.9) row.ninety_day = d + 1;
      }
      row.first2_share = (views[0] + views[1]) / first30;
      if (daysBetween(post.published, lastDate) >= 90) row.after30_share = views.slice(30).reduce((s, v) => s + v, 0) / views.reduce((s, v) => s + v, 0);
    }
    rows.push(row);
  }
  const summarize = (list) => {
    const measured = list.filter((r) => r.half_day != null);
    const aged = measured.filter((r) => r.after30_share != null);
    return {
      articles: list.length,
      measured: measured.length,
      median_first_30_day_pageviews: round(median(list.map((r) => r.first30))),
      median_days_to_half_of_first_month: median(measured.map((r) => r.half_day)),
      median_days_to_90pct_of_first_month: median(measured.map((r) => r.ninety_day)),
      median_first_2_days_share_pct: round((median(measured.map((r) => r.first2_share)) ?? NaN) * 100),
      median_traffic_after_day_30_pct: aged.length ? round(median(aged.map((r) => r.after30_share)) * 100) : null,
      median_days_to_first_google_click: median(list.map((r) => r.first_click_day)),
      google_click_within_3_days_pct: pct(list.filter((r) => r.first_click_day != null && r.first_click_day < 3).length, list.length),
      no_google_click_in_30_days_pct: pct(list.filter((r) => r.first_click_day == null).length, list.length),
    };
  };
  const byKind = {};
  for (const kind of Object.keys(KIND_LABELS)) {
    const list = rows.filter((r) => r.kind === kind);
    if (list.length >= 5) byKind[kind] = summarize(list);
  }
  return { all: summarize(rows), by_kind: byKind };
}

/** How much Google traffic the back catalog earns (last 90 days of data). */
function archiveReach(posts, index, gscDates) {
  const last = gscDates.slice(-90);
  if (!last.length) return null;
  const cutoff = addDays(last[0], -30);
  const catalog = posts.filter((p) => p.published < cutoff);
  const earners = catalog.map((p) => {
    const series = index.byKey.get(p.key);
    return { post: p, clicks: last.reduce((s, d) => s + (series?.get(d)?.web_clicks ?? 0), 0) };
  }).sort((a, b) => b.clicks - a.clicks);
  const total = earners.reduce((s, e) => s + e.clicks, 0);
  const topShare = (n) => pct(earners.slice(0, n).reduce((s, e) => s + e.clicks, 0), total);
  const olderThanYear = earners.filter((e) => daysBetween(e.post.published, last.at(-1)) >= 365);
  return {
    period: { start: last[0], end: last.at(-1), days: last.length },
    articles_older_than_30_days: catalog.length,
    with_any_google_click: earners.filter((e) => e.clicks > 0).length,
    with_30_plus_clicks: earners.filter((e) => e.clicks >= 30).length,
    google_clicks_total: total,
    top_10_share_pct: topShare(10),
    top_50_share_pct: topShare(50),
    from_articles_over_a_year_old_pct: pct(olderThanYear.reduce((s, e) => s + e.clicks, 0), total),
    top_earners: earners.slice(0, 10).filter((e) => e.clicks > 0).map((e) => ({
      title: e.post.title, url: e.post.url, kind: e.post.kind, published: e.post.published, google_clicks: e.clicks,
    })),
  };
}

/**
 * The whole report from stored daily rows. Pure; exported for tests.
 * @param {object} input
 * @param {object[]} input.site   altus_daily_site rows (date as YYYY-MM-DD)
 * @param {object[]} input.pages  altus_daily_page rows
 * @param {object[]} input.posts  { url, title, published_at, categories, tags, content_type }
 * @param {string} input.today    YYYY-MM-DD in AltWire time
 */
export function analyzeTraffic({ site, pages, posts, today, brand = null, analysisDays = ANALYSIS_DAYS }) {
  const windowStart = addDays(today, -analysisDays);
  const siteRows = [...site].sort((a, b) => a.date.localeCompare(b.date));
  const siteByDate = new Map(siteRows.map((r) => [r.date, r]));
  const visits = siteRows.filter((r) => r.visits != null && r.date < today);
  if (visits.length < MIN_BASELINE_DAYS + 7) return { error: 'Not enough daily traffic data yet' };

  const { days: marked, weekdayFactors } = markSpikes(visits.map((r) => ({ date: r.date, value: r.visits })));
  const inWindow = marked.filter((d) => d.date >= windowStart && d.expected != null);
  const episodes = findEpisodes(inWindow);

  const postList = (posts ?? []).filter((p) => p.url && p.published_at).map((p) => ({
    key: urlKey(p.url), url: p.url, title: p.title, published: localDate(p.published_at), kind: articleKind(p),
  }));
  const postsByKey = new Map();
  for (const p of postList) if (!postsByKey.has(p.key)) postsByKey.set(p.key, p);
  const index = indexPages(pages);
  const windowDates = inWindow.map((d) => d.date);

  for (const e of episodes) {
    e.drivers = spikeDrivers(e, index, postsByKey);
    Object.assign(e, sourceShift(e, siteByDate, windowDates));
    e.led_by_fresh_article = e.drivers[0]?.fresh ?? null;
  }

  const spikeDates = new Set(inWindow.filter((d) => d.spike).map((d) => d.date));
  const normalDates = windowDates.filter((d) => !spikeDates.has(d));
  const totalVisits = inWindow.reduce((s, d) => s + d.value, 0);
  const extra = episodes.reduce((s, e) => s + (e.extra_visits ?? 0), 0);
  const ledByFresh = episodes.filter((e) => e.led_by_fresh_article != null);

  const gscDates = siteRows.filter((r) => r.web_clicks != null && r.date >= windowStart).map((r) => r.date);
  const latest = inWindow.at(-1);
  const current = episodes.find((e) => e.ongoing);

  const months = new Map();
  for (const d of inWindow.filter((x) => !x.spike)) {
    const m = d.date.slice(0, 7);
    if (!months.has(m)) months.set(m, []);
    months.get(m).push(d.value);
  }

  return {
    window: { start: windowDates[0], end: windowDates.at(-1), days: windowDates.length },
    normal_day: {
      visits_now: round(latest.expected / (weekdayFactors[weekday(latest.date)] || 1)),
      by_weekday_pct: Object.fromEntries(WEEKDAYS.map((name, i) => [name, round((weekdayFactors[i] - 1) * 100)])),
      by_month: [...months].map(([month, vals]) => ({ month, median_visits: round(median(vals)) })),
    },
    latest_day: {
      date: latest.date,
      visits: latest.value,
      expected: round(latest.expected),
      vs_expected_pct: round((latest.ratio - 1) * 100),
      spike: latest.spike,
      ...(current ? { spike_day: daysBetween(current.start, latest.date) + 1, spike_started: current.start } : {}),
    },
    spikes: {
      count: episodes.length,
      per_month: round(episodes.length / (windowDates.length / 30.4), 1),
      spike_days_pct: pct(spikeDates.size, windowDates.length),
      extra_visits_share_pct: pct(extra, totalVisits),
      typical: {
        peak_multiple: round(median(episodes.map((e) => e.peak_multiple)), 1),
        days_elevated: median(episodes.map((e) => e.days_elevated)),
        days_peak_to_normal: median(episodes.map((e) => e.days_peak_to_normal)),
      },
      led_by_article_under_7_days_old_pct: pct(ledByFresh.filter((e) => e.led_by_fresh_article).length, ledByFresh.length),
      biggest: [...episodes].sort((a, b) => b.extra_visits - a.extra_visits).slice(0, 10),
      recent: episodes.slice(-3).reverse(),
    },
    pageviews_by_article_age_pct: {
      all_days: mixFor(windowDates, index, postsByKey, siteByDate, 'pageviews', { untracked: true }),
      spike_days: spikeDates.size ? mixFor([...spikeDates], index, postsByKey, siteByDate, 'pageviews', { untracked: true }) : null,
      normal_days: mixFor(normalDates, index, postsByKey, siteByDate, 'pageviews', { untracked: true }),
    },
    google_clicks_by_article_age_pct: gscDates.length ? mixFor(gscDates, index, postsByKey, siteByDate, 'web_clicks') : null,
    article_lifecycle: articleDecay(postList, index, windowStart, windowDates.at(-1)),
    back_catalog: archiveReach(postList, index, gscDates),
    ...(brand ? { brand_searches: brand } : {}),
    definitions: {
      expected: `median of the previous ${BASELINE_WINDOW} non-spike days, adjusted for the weekday`,
      spike: `a day at least ${SPIKE_THRESHOLD}x expected visits; consecutive spike days are one spike`,
      back_to_normal: `the first day after the peak within ${Math.round((BACK_TO_NORMAL - 1) * 100)}% of expected`,
      article_age: 'fresh: under 7 days; recent: 7–29 days; this_year: 30–364 days; archive: a year or older; not_article: home, category and tag pages; smaller_pages: pages outside Matomo\'s daily top 500',
    },
    note: 'Covers the last 12 months only: AltWire was barely optimized for years before that, so older traffic describes a different site. The domain dates from 2013, which likely helps new articles rank quickly on timely searches even though few people search for AltWire by name. Visits and pageviews are Matomo; Google clicks are Search Console (about 3 days behind).',
  };
}

/** Share of Google clicks from searches that name AltWire (last 28 days). */
async function brandShare(today, gsc = getSearchPerformance) {
  const end = addDays(today, -GSC_LAG_DAYS);
  const res = await gsc(addDays(end, -27), end, { dimensions: ['query'], rowLimit: 25000 });
  if (res?.error) return null;
  const total = res.rows.reduce((s, r) => s + (r.clicks ?? 0), 0);
  const brand = res.rows.filter((r) => /alt\s?wire/i.test(r.keys?.[0] ?? '')).reduce((s, r) => s + (r.clicks ?? 0), 0);
  return { period_days: 28, clicks_naming_altwire_pct: pct(brand, total), note: 'Search Console hides rare queries, so this is approximate.' };
}

/** Sync the daily tables, rebuild the report and store it. */
export async function refreshTrafficPatterns({ deps = {}, now = new Date() } = {}) {
  const sync = await syncDailyTraffic({ deps, now });
  const today = localDate(now);
  // The analysis window plus room for the first baselines and spike lookbacks.
  const since = addDays(today, -(ANALYSIS_DAYS + BASELINE_WINDOW + MIN_BASELINE_DAYS + 30));
  const [{ rows: site }, { rows: pages }, { rows: posts }, brand] = await Promise.all([
    pool.query(
      `SELECT date::text AS date, visits, pageviews, ref_search, ref_social, ref_direct, ref_websites, ref_other,
              web_clicks, web_impressions, news_clicks, discover_clicks
         FROM altus_daily_site WHERE date >= $1 ORDER BY date`,
      [since],
    ),
    // Rows with only impressions don't change any figure here; skipping them keeps this small.
    pool.query(
      `SELECT date::text AS date, url_key, pageviews, web_clicks, news_clicks, discover_clicks
         FROM altus_daily_page
        WHERE date >= $1 AND (pageviews > 0 OR web_clicks > 0 OR news_clicks > 0 OR discover_clicks > 0)`,
      [since],
    ),
    pool.query("SELECT url, title, published_at, categories, tags, content_type FROM altus_content WHERE url IS NOT NULL AND content_type IN ('post', 'gallery')"),
    brandShare(today, deps.gscQueries).catch(() => null),
  ]);
  const report = analyzeTraffic({ site, pages, posts, today, brand });
  if (report.error) {
    logger.warn('Traffic patterns not rebuilt', { error: report.error, sync: sync.error ?? null });
    return { error: report.error };
  }
  if (sync.error) report.data_warning = `Latest sync incomplete: ${sync.error}`;
  const computedAt = await kvSet(PATTERNS_KEY, report);
  logger.info('Traffic patterns rebuilt', { days: report.window.days, spikes: report.spikes.count });
  return { ...report, computed_at: computedAt };
}

/**
 * The stored report. The first build backfills over a year of daily data, so
 * it only happens in the nightly job or with refresh.
 */
export async function getTrafficPatterns({ refresh = false } = {}) {
  if (refresh) return refreshTrafficPatterns();
  const stored = await kvGet(PATTERNS_KEY);
  if (stored) return { ...stored.value, computed_at: stored.computed_at };
  return { error: 'Traffic patterns have not been built yet. They build nightly at 4:40 AM ET (the first build backfills a year of data); pass refresh=true to build now.' };
}

/** Compact form for the daily digest. */
export function summarizePatterns(report) {
  if (!report || report.error) return report ?? null;
  return {
    computed_at: report.computed_at,
    latest_day: report.latest_day,
    normal_visits_per_day: report.normal_day.visits_now,
    typical_spike: report.spikes.typical,
    spikes_per_month: report.spikes.per_month,
    spikes_led_by_fresh_article_pct: report.spikes.led_by_article_under_7_days_old_pct,
    current_spike_drivers: report.latest_day.spike ? (report.spikes.recent[0]?.drivers ?? []) : [],
    note: 'latest_day compares yesterday\'s Matomo visits with a normal day for that weekday. A spike is 1.5x expected or more; typical_spike says how long spikes usually last and how many days they take to fade back to normal.',
  };
}
