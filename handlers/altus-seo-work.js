/**
 * SEO optimization work for the agent: finding the AltWire articles whose
 * titles and descriptions are costing the most clicks, applying approved
 * changes through the Cirrusly SEO plugin, and measuring what each change did.
 *
 * Candidates come from Search Console page totals for the last 28 days,
 * joined with the archive (to get WordPress IDs) and the plugin's stored SEO
 * fields. Each is scored by the clicks it would gain at the click-through
 * rate typical for its position, so the list leads with the biggest
 * opportunity rather than the most traffic.
 *
 * Every change is logged in altus_seo_changes with the fields before and
 * after and a 28-day Search Console baseline. Once 28 days have passed (plus
 * the reporting lag), the same window after the change is compared with it.
 */

import pool from '../lib/altus-db.js';
import { logger } from '../logger.js';
import { getSeoState, getSeoStateBulk, updateSeoFields } from '../lib/wp-client.js';
import { getPageSearchDetail, getSearchPerformance } from './altwire-gsc-client.js';
import { getLagAwareGscWindow } from '../lib/gsc-date-window.js';

export const RESULT_DAYS = 28;
export const GSC_LAG_DAYS = 3;
export const RECENT_CHANGE_DAYS = 45;
const TRANSLATED_PATH_RE = /^https?:\/\/[^/]+\/[a-z]{2}(?:-[a-z]{2})?\//i;
// " - AltWire" is appended to every title.
const TITLE_SUFFIX_LENGTH = 10;

// Cirrusly SEO reason codes in plain words.
export const SEO_REASON_LABELS = {
  ctr_gap: 'seen but rarely clicked',
  declining_target: 'slipping in Google',
  position_gap: 'stuck past page one',
  near_striking_distance: 'close to the top',
  new_query: 'new search term',
  rising_target: 'climbing in Google',
};

/**
 * The SEO queue for the digest: how many items are waiting, how many were
 * queued since yesterday, and the newest ones in plain words. Pure;
 * exported for tests.
 *
 * @param {object[]} items  queue items (status accepted) from the plugin
 * @param {string} sinceDate  YYYY-MM-DD; items first queued on or after it count as new
 */
export function summarizeSeoQueue(items, sinceDate, { limit = 10 } = {}) {
  const list = [...(items ?? [])].sort((a, b) => String(b.first_seen ?? '').localeCompare(String(a.first_seen ?? '')));
  return {
    waiting: list.length,
    new_since_yesterday: list.filter((i) => String(i.first_seen ?? '') >= sinceDate).length,
    items: list.slice(0, limit).map((i) => ({
      query: i.query || null,
      url: i.page_url || null,
      reason: SEO_REASON_LABELS[i.reason_code] ?? (i.reason_code || null),
      queued_by: ['hal', 'agent'].includes(i.source) ? 'agent' : 'person',
      queued_on: i.first_seen ?? null,
      notes: i.notes || null,
    })),
  };
}

export const urlKey = (url) => String(url ?? '').replace(/\/+$/, '').toLowerCase();

export async function ensureSeoChangesTable(client = pool) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS altus_seo_changes (
      id                SERIAL PRIMARY KEY,
      object_type       TEXT NOT NULL DEFAULT 'post',
      object_id         INTEGER NOT NULL,
      url               TEXT,
      url_key           TEXT,
      before            JSONB NOT NULL,
      after             JSONB NOT NULL,
      reason            TEXT,
      changed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      baseline          JSONB,
      result            JSONB,
      result_checked_at TIMESTAMPTZ
    )
  `);
  await client.query('CREATE INDEX IF NOT EXISTS altus_seo_changes_url_key_idx ON altus_seo_changes (url_key, changed_at DESC)');
}

/**
 * Typical Google click-through rate by average position (organic web
 * results, rough industry averages). Used only to rank opportunities.
 */
export function expectedCtr(position) {
  const p = Number(position);
  if (!Number.isFinite(p) || p <= 0) return 0;
  const table = [0.28, 0.15, 0.1, 0.07, 0.05, 0.04, 0.03, 0.025, 0.02, 0.018];
  if (p <= 10) return table[Math.max(0, Math.round(p) - 1)];
  if (p <= 20) return 0.01;
  return 0.004;
}

/** Clicks a page would gain over the window at the typical CTR for its position. */
export function estimatedExtraClicks({ impressions = 0, ctr = 0, position = 0 }) {
  return Math.max(0, Math.round(impressions * (expectedCtr(position) - ctr)));
}

/**
 * What's wrong with a page's SEO fields, given its stored values, what it
 * renders, and its search numbers.
 */
export function auditSeo({ seo = {}, rendered = null, search = {} }) {
  const issues = [];
  const title = rendered?.title ?? seo.title ?? '';
  const description = seo.description ?? '';
  const titleLength = title.length + TITLE_SUFFIX_LENGTH;

  if (!description.trim()) issues.push({ code: 'missing_description', detail: 'No meta description; Google uses page text instead.' });
  else if (description.length > 160) issues.push({ code: 'description_too_long', detail: `Meta description is ${description.length} characters; Google cuts off around 155.` });
  else if (description.length < 70) issues.push({ code: 'description_too_short', detail: `Meta description is only ${description.length} characters.` });

  if (titleLength > 62) issues.push({ code: 'title_too_long', detail: `Title is ${titleLength} characters with " - AltWire"; Google cuts off around 60.` });
  else if (title.length > 0 && title.length < 20) issues.push({ code: 'title_too_short', detail: `Title is only ${title.length} characters.` });

  const expected = expectedCtr(search.position);
  if ((search.impressions ?? 0) >= 100 && expected > 0 && (search.ctr ?? 0) < expected * 0.6) {
    issues.push({
      code: 'low_ctr',
      detail: `Clicked ${((search.ctr ?? 0) * 100).toFixed(1)}% of the time at position #${Number(search.position).toFixed(1)}; around ${(expected * 100).toFixed(0)}% is typical.`,
    });
  }
  if (!String(seo.focus_keyword ?? '').trim()) issues.push({ code: 'no_focus_keyword', detail: 'No focus keyword set.' });
  return issues;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  for (let i = 0; i < items.length; i += limit) {
    const chunk = items.slice(i, i + limit);
    const results = await Promise.all(chunk.map((item, j) => fn(item, i + j)));
    results.forEach((r, j) => { out[i + j] = r; });
  }
  return out;
}

/**
 * The articles with the most to gain from better titles and descriptions.
 *
 * @param {{ limit?: number, minImpressions?: number, includeRecent?: boolean, deps?: object }} [opts]
 */
export async function findSeoCandidates({ limit = 10, minImpressions = 50, includeRecent = false, deps = {} } = {}) {
  const {
    gsc = getSearchPerformance,
    seoBulk = getSeoStateBulk,
    detail = getPageSearchDetail,
  } = deps;
  const window = getLagAwareGscWindow(RESULT_DAYS, GSC_LAG_DAYS);

  const pages = await gsc(window.startDate, window.endDate, { rowLimit: 1000, dimensions: ['page'] });
  if (pages?.error) return { error: `Search Console: ${pages.message ?? pages.error}` };

  const { rows: content } = await pool.query(
    `SELECT DISTINCT ON (lower(rtrim(url, '/'))) wp_id, title, url, published_at
       FROM altus_content
      WHERE content_type IN ('post', 'page') AND url IS NOT NULL
      ORDER BY lower(rtrim(url, '/')), published_at DESC NULLS LAST`,
  );
  const byUrl = new Map(content.map((c) => [urlKey(c.url), c]));

  await ensureSeoChangesTable();
  const { rows: recent } = await pool.query(
    `SELECT url_key, MAX(changed_at) AS changed_at FROM altus_seo_changes
      WHERE changed_at > NOW() - ($1 || ' days')::interval GROUP BY url_key`,
    [String(RECENT_CHANGE_DAYS)],
  );
  const recentlyChanged = new Map(recent.map((r) => [r.url_key, r.changed_at]));

  const traffic = (pages.rows ?? [])
    .map((r) => ({ url: r.keys?.[0], clicks: r.clicks ?? 0, impressions: r.impressions ?? 0, ctr: r.ctr ?? 0, position: r.position ?? 0 }))
    .filter((r) => r.url && !TRANSLATED_PATH_RE.test(r.url) && r.impressions >= minImpressions)
    .map((r) => ({ ...r, article: byUrl.get(urlKey(r.url)) }))
    .filter((r) => r.article)
    .filter((r) => includeRecent || !recentlyChanged.has(urlKey(r.url)))
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 200);

  const { items } = await seoBulk(traffic.map((r) => r.article.wp_id));
  const seoById = new Map(items.map((i) => [i.id, i]));

  const backlog = { missing_description: 0, low_ctr: 0, title_too_long: 0, no_focus_keyword: 0 };
  const scored = [];
  for (const page of traffic) {
    const state = seoById.get(page.article.wp_id);
    if (!state || state.seo?.noindex) continue;
    const search = { clicks: page.clicks, impressions: page.impressions, ctr: page.ctr, position: page.position };
    const issues = auditSeo({ seo: state.seo, rendered: state.rendered, search });
    for (const issue of issues) if (issue.code in backlog) backlog[issue.code] += 1;
    if (!issues.some((i) => i.code !== 'no_focus_keyword')) continue;
    scored.push({
      wp_id: page.article.wp_id,
      url: page.url,
      title: state.context?.name ?? page.article.title,
      published_at: page.article.published_at,
      seo: state.seo,
      rendered: state.rendered ?? null,
      search: { ...search, ctr: Math.round(search.ctr * 1000) / 10, position: Math.round(search.position * 10) / 10 },
      issues,
      estimated_extra_clicks: estimatedExtraClicks(search),
    });
  }
  scored.sort((a, b) => b.estimated_extra_clicks - a.estimated_extra_clicks || b.search.impressions - a.search.impressions);
  const top = scored.slice(0, Math.min(Math.max(Number(limit) || 10, 1), 25));

  await mapLimit(top, 5, async (candidate) => {
    const d = await detail(candidate.url, window.startDate, window.endDate, { topQueries: 5 });
    candidate.top_queries = d?.error ? [] : d.top_queries;
  });

  return {
    window: { start: window.startDate, end: window.endDate },
    pages_reviewed: traffic.length,
    pages_with_issues: scored.length,
    backlog,
    candidates: top,
    note: 'Search Console web search, last 28 days (about 3 days behind). search.ctr is a percentage. estimated_extra_clicks is the clicks over 28 days the page would gain at the typical click-through rate for its position: a ranking of opportunity, not a forecast. Pages changed in the last 45 days are left out so changes can settle (include_recently_changed overrides). rendered is what the page outputs now.',
  };
}

/**
 * Apply an approved SEO change and log it with a Search Console baseline.
 *
 * @param {{ objectType: string, objectId: number, fields: object, reason: string, deps?: object, now?: Date }} params
 */
export async function applySeoChange({ objectType, objectId, fields, reason, deps = {}, now = new Date() }) {
  const { read = getSeoState, write = updateSeoFields, detail = getPageSearchDetail } = deps;
  const current = await read({ objectType, objectId });
  const pluginNames = { seo_title: 'title', meta_description: 'description', focus_keyword: 'focus_keyword', canonical: 'canonical', noindex: 'noindex' };
  const before = {};
  for (const name of Object.keys(fields)) before[name] = current?.seo?.[pluginNames[name]] ?? null;

  const response = await write({ objectType, objectId, fields });
  const after = {};
  for (const name of Object.keys(fields)) after[name] = response?.updated?.[pluginNames[name]] ?? fields[name];

  const url = current?.context?.url ?? null;
  let baseline = null;
  if (url) {
    const end = new Date(now.getTime() - GSC_LAG_DAYS * 86400000);
    const start = new Date(end.getTime() - (RESULT_DAYS - 1) * 86400000);
    const window = { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
    try {
      const d = await detail(url, window.start, window.end, { topQueries: 5 });
      baseline = d?.error ? null : { window, search: d.search, news: d.news, top_queries: d.top_queries };
    } catch (err) {
      logger.warn('SEO change baseline unavailable', { url, error: err.message });
    }
  }

  await ensureSeoChangesTable();
  const { rows } = await pool.query(
    `INSERT INTO altus_seo_changes (object_type, object_id, url, url_key, before, after, reason, changed_at, baseline)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [objectType, objectId, url, url ? urlKey(url) : null, JSON.stringify(before), JSON.stringify(after), reason ?? null, now.toISOString(), baseline ? JSON.stringify(baseline) : null],
  );

  return {
    success: true,
    change_id: rows[0].id,
    url,
    before,
    after,
    baseline,
    note: baseline
      ? `Logged. get_altwire_seo_results compares the ${RESULT_DAYS} days after this change with the baseline once they are in Search Console (about ${RESULT_DAYS + GSC_LAG_DAYS} days).`
      : 'Logged without a Search Console baseline, so results can\'t be measured for this change.',
  };
}

function pct(after, before) {
  if (!before) return null;
  return Math.round(((after - before) / before) * 1000) / 10;
}

/** Compare a change's after-window with its baseline. Pure; exported for tests. */
export function compareResult(baseline, result) {
  const b = baseline?.search;
  const a = result?.search;
  if (!b || !a) return null;
  const bCtr = b.impressions ? b.clicks / b.impressions : 0;
  const aCtr = a.impressions ? a.clicks / a.impressions : 0;
  const clicksPct = pct(a.clicks, b.clicks);
  let verdict = 'no_clear_change';
  if (a.clicks - b.clicks >= 5 && (clicksPct ?? 100) >= 10) verdict = 'improved';
  else if (b.clicks - a.clicks >= 5 && (clicksPct ?? 0) <= -10) verdict = 'declined';
  return {
    clicks: { before: b.clicks, after: a.clicks, change_pct: clicksPct },
    impressions: { before: b.impressions, after: a.impressions, change_pct: pct(a.impressions, b.impressions) },
    ctr_pct: { before: Math.round(bCtr * 1000) / 10, after: Math.round(aCtr * 1000) / 10 },
    position: { before: b.position, after: a.position },
    verdict,
  };
}

/**
 * Measure changes whose after-window is now complete, then list recent
 * changes with their outcome.
 *
 * @param {{ limit?: number, deps?: object, now?: Date }} [opts]
 */
export async function getSeoChangeResults({ limit = 20, deps = {}, now = new Date() } = {}) {
  const { detail = getPageSearchDetail } = deps;
  await ensureSeoChangesTable();

  const { rows: due } = await pool.query(
    `SELECT id, url, changed_at FROM altus_seo_changes
      WHERE result_checked_at IS NULL AND url IS NOT NULL AND baseline IS NOT NULL
        AND changed_at <= $1::timestamptz - ($2 || ' days')::interval
      ORDER BY changed_at LIMIT 25`,
    [now.toISOString(), String(RESULT_DAYS + GSC_LAG_DAYS + 1)],
  );
  for (const change of due) {
    const start = new Date(new Date(change.changed_at).getTime() + 86400000);
    const end = new Date(start.getTime() + (RESULT_DAYS - 1) * 86400000);
    const window = { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
    const d = await detail(change.url, window.start, window.end, { topQueries: 5 });
    if (d?.error) {
      logger.warn('SEO change result unavailable; will retry', { id: change.id, error: d.error });
      continue;
    }
    await pool.query(
      'UPDATE altus_seo_changes SET result = $2, result_checked_at = NOW() WHERE id = $1',
      [change.id, JSON.stringify({ window, search: d.search, news: d.news, top_queries: d.top_queries })],
    );
  }

  const { rows } = await pool.query(
    'SELECT * FROM altus_seo_changes ORDER BY changed_at DESC LIMIT $1',
    [Math.min(Math.max(Number(limit) || 20, 1), 100)],
  );
  const { rows: [counts] } = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE result IS NOT NULL)::int AS measured,
            COUNT(*) FILTER (WHERE result IS NULL)::int AS waiting
       FROM altus_seo_changes`,
  );

  const changes = rows.map((r) => {
    const comparison = r.result ? compareResult(r.baseline, r.result) : null;
    const dueOn = new Date(new Date(r.changed_at).getTime() + (RESULT_DAYS + GSC_LAG_DAYS + 1) * 86400000).toISOString().slice(0, 10);
    return {
      change_id: r.id,
      object_id: r.object_id,
      url: r.url,
      changed_at: r.changed_at,
      reason: r.reason,
      before: r.before,
      after: r.after,
      ...(comparison ? { outcome: comparison } : { outcome: null, results_due: r.baseline ? dueOn : 'no baseline' }),
    };
  });

  const measured = changes.filter((c) => c.outcome);
  return {
    totals: counts,
    summary: measured.length ? {
      improved: measured.filter((c) => c.outcome.verdict === 'improved').length,
      declined: measured.filter((c) => c.outcome.verdict === 'declined').length,
      no_clear_change: measured.filter((c) => c.outcome.verdict === 'no_clear_change').length,
    } : null,
    changes,
    note: `Each outcome compares the ${RESULT_DAYS} days after a change with the ${RESULT_DAYS} days before it (Search Console web search). Seasonality, news, and Google updates also move these numbers, so read a single result as a hint and look for patterns across many. verdict: improved / declined need a change of at least 5 clicks and 10%.`,
  };
}
