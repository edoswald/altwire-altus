/**
 * AltWire's monthly history: site traffic (Matomo) and Google web search
 * (Search Console) per calendar month, with month-over-month and
 * year-over-year comparisons. Deterministic (no model) and rebuilt daily
 * from the source APIs, so it replaces the Hal-era 18-month summaries, which
 * were built from overlapping weekly data and had mislabeled windows.
 *
 * Stored as one JSON document in altus_kv. A failed source leaves the last
 * good build in place.
 */

import pool from '../lib/altus-db.js';
import { logger } from '../logger.js';
import { getMonthlyTotals } from './altwire-matomo-client.js';
import { getDailySearchTotals } from './altwire-gsc-client.js';
import { pctChange } from './altus-digest-analytics.js';

export const HISTORY_KEY = 'analytics:monthly_history';
const MATOMO_MONTHS = 25;
const GSC_MONTHS = 16;
const GSC_LAG_DAYS = 3;
const TIME_ZONE = 'America/New_York';

export async function ensureKvTable(client = pool) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS altus_kv (
      key         TEXT PRIMARY KEY,
      value       JSONB NOT NULL,
      computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

function todayIn(timeZone, now) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

function shiftMonth(month, delta) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

function daysInMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * Roll daily Search Console rows up to months. Position is weighted by
 * impressions; a month is complete only when every day has data.
 */
export function rollUpSearchByMonth(rows) {
  const months = new Map();
  for (const r of rows ?? []) {
    const month = r.date.slice(0, 7);
    if (!months.has(month)) months.set(month, { clicks: 0, impressions: 0, weighted: 0, days: 0 });
    const m = months.get(month);
    m.clicks += r.clicks;
    m.impressions += r.impressions;
    m.weighted += (r.position ?? 0) * r.impressions;
    m.days += 1;
  }
  const out = {};
  for (const [month, m] of months) {
    out[month] = {
      clicks: m.clicks,
      impressions: m.impressions,
      ctr_pct: m.impressions ? Math.round((m.clicks / m.impressions) * 1000) / 10 : null,
      position: m.impressions ? Math.round((m.weighted / m.impressions) * 10) / 10 : null,
      days: m.days,
      complete: m.days === daysInMonth(month),
    };
  }
  return out;
}

function changes(cur, prev) {
  if (!cur || !prev) return null;
  return {
    pageviews_pct: pctChange(cur.matomo?.pageviews, prev.matomo?.pageviews),
    visits_pct: pctChange(cur.matomo?.visits, prev.matomo?.visits),
    search_clicks_pct: pctChange(cur.search?.clicks, prev.search?.clicks),
    search_impressions_pct: pctChange(cur.search?.impressions, prev.search?.impressions),
  };
}

function sumMonths(list) {
  const total = (pick) => {
    const vals = list.map(pick);
    return vals.every((v) => Number.isFinite(v)) ? vals.reduce((a, b) => a + b, 0) : null;
  };
  return {
    matomo: { pageviews: total((m) => m?.matomo?.pageviews), visits: total((m) => m?.matomo?.visits) },
    search: { clicks: total((m) => m?.search?.clicks), impressions: total((m) => m?.search?.impressions) },
  };
}

/**
 * Join Matomo and Search Console months and compute comparisons. Pure;
 * exported for tests. `currentMonth` is the (partial) month in progress.
 */
export function buildHistory(matomoMonths, searchMonths, currentMonth) {
  const keys = [...new Set([...Object.keys(matomoMonths), ...Object.keys(searchMonths)])].sort().reverse();
  const months = keys.map((month) => {
    const s = searchMonths[month];
    return {
      month,
      partial: month >= currentMonth,
      matomo: matomoMonths[month] ?? null,
      search: s ? { clicks: s.clicks, impressions: s.impressions, ctr_pct: s.ctr_pct, position: s.position, ...(s.complete ? {} : { partial_days: s.days }) } : null,
    };
  });
  const byMonth = new Map(months.map((m) => [m.month, m]));
  const lastComplete = shiftMonth(currentMonth, -1);
  const cur = byMonth.get(lastComplete);
  const trailing = [0, 1, 2].map((i) => shiftMonth(lastComplete, -i));
  const trailingPrior = trailing.map((m) => shiftMonth(m, -12));
  // Search comparisons are only valid when both sides are full months.
  const fullSearch = (m) => !!searchMonths[m]?.complete;
  const strip = (cmp, ok) => (cmp && !ok ? { ...cmp, search_clicks_pct: null, search_impressions_pct: null } : cmp);

  const complete = months.filter((m) => !m.partial);
  const best = (pick) => complete.reduce((top, m) => ((pick(m) ?? -1) > (pick(top) ?? -1) ? m : top), complete[0] ?? null);
  const bestViews = best((m) => m.matomo?.pageviews);
  const bestClicks = best((m) => (searchMonths[m.month]?.complete ? m.search?.clicks : null));

  return {
    months,
    last_complete_month: cur ? {
      month: lastComplete,
      vs_previous_month: strip(changes(cur, byMonth.get(shiftMonth(lastComplete, -1))), fullSearch(lastComplete) && fullSearch(shiftMonth(lastComplete, -1))),
      vs_year_earlier: strip(changes(cur, byMonth.get(shiftMonth(lastComplete, -12))), fullSearch(lastComplete) && fullSearch(shiftMonth(lastComplete, -12))),
    } : null,
    last_3_months: {
      months: [...trailing].reverse(),
      vs_year_earlier: strip(
        changes(sumMonths(trailing.map((m) => byMonth.get(m))), sumMonths(trailingPrior.map((m) => byMonth.get(m)))),
        [...trailing, ...trailingPrior].every(fullSearch),
      ),
    },
    best_month: {
      pageviews: bestViews?.matomo ? { month: bestViews.month, pageviews: bestViews.matomo.pageviews } : null,
      search_clicks: bestClicks?.search && searchMonths[bestClicks.month]?.complete ? { month: bestClicks.month, clicks: bestClicks.search.clicks } : null,
    },
  };
}

/**
 * Rebuild the history from Matomo and Search Console and store it. Leaves
 * the previous build in place if either source fails.
 */
export async function refreshAnalyticsHistory({ deps = {}, now = new Date() } = {}) {
  const { matomo = getMonthlyTotals, gsc = getDailySearchTotals } = deps;
  const today = todayIn(TIME_ZONE, now);
  const currentMonth = today.slice(0, 7);
  const gscEnd = new Date(`${today}T12:00:00Z`);
  gscEnd.setUTCDate(gscEnd.getUTCDate() - GSC_LAG_DAYS);
  const gscStart = `${shiftMonth(currentMonth, -GSC_MONTHS)}-01`;
  const gscEndDate = gscEnd.toISOString().slice(0, 10);

  const [m, g] = await Promise.all([matomo(MATOMO_MONTHS), gsc(gscStart, gscEndDate)]);
  if (m?.error || g?.error) {
    logger.warn('Analytics history not rebuilt; keeping the last build', { matomo: m?.error ?? null, gsc: g?.error ?? null });
    return { error: m?.error ? `Matomo: ${m.message ?? m.error}` : `Search Console: ${g.message ?? g.error}` };
  }

  const searchMonths = rollUpSearchByMonth(g.rows);
  const history = {
    ...buildHistory(m, searchMonths, currentMonth),
    sources: {
      matomo: `site visits and pageviews, ${Object.keys(m).length} months`,
      search: `Google web search (Search Console, final data) from ${g.rows[0]?.date ?? gscStart} to ${g.rows.at(-1)?.date ?? gscEndDate}`,
    },
    note: 'Months are calendar months in AltWire time; the current month is partial, and Search Console lags about 3 days. Search Console keeps 16 months, so search year-over-year covers only recent months (null where either side is incomplete). Matomo and Search Console measure different things: on-site views vs. clicks from Google.',
  };
  await ensureKvTable();
  const { rows } = await pool.query(
    `INSERT INTO altus_kv (key, value, computed_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at
     RETURNING computed_at`,
    [HISTORY_KEY, JSON.stringify(history)],
  );
  logger.info('Analytics history rebuilt', { months: history.months.length });
  return { ...history, computed_at: rows[0].computed_at };
}

/** The stored history, building it first if there is none. */
export async function getAnalyticsHistory() {
  await ensureKvTable();
  const { rows } = await pool.query('SELECT value, computed_at FROM altus_kv WHERE key = $1', [HISTORY_KEY]);
  if (rows.length) return { ...rows[0].value, computed_at: rows[0].computed_at };
  return refreshAnalyticsHistory();
}

/** Compact form for the digest and the combined-analytics synthesis. */
export function summarizeHistory(history, { months = 13 } = {}) {
  if (!history || history.error) return history ?? null;
  return {
    computed_at: history.computed_at,
    last_complete_month: history.last_complete_month,
    last_3_months: history.last_3_months,
    best_month: history.best_month,
    recent_months: history.months.slice(0, months).map((m) => ({
      month: m.month,
      ...(m.partial ? { partial: true } : {}),
      pageviews: m.matomo?.pageviews ?? null,
      visits: m.matomo?.visits ?? null,
      search_clicks: m.search?.clicks ?? null,
      search_impressions: m.search?.impressions ?? null,
    })),
    note: history.note,
  };
}
