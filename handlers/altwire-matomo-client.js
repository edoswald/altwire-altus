/**
 * Matomo Reporting API client for AltWire.
 *
 * Reads ALTWIRE_MATOMO_URL, ALTWIRE_MATOMO_TOKEN_AUTH, ALTWIRE_MATOMO_SITE_ID from environment.
 * Returns structured error when env vars are missing.
 * All functions use async fetch() exclusively.
 */

import { logger } from '../logger.js';

/**
 * Check that all required Matomo env vars are present.
 * @returns {{ configured: true, url: string, token: string, siteId: string } | { configured: false, error: string }}
 */
function getConfig() {
  const url = process.env.ALTWIRE_MATOMO_URL;
  const token = process.env.ALTWIRE_MATOMO_TOKEN_AUTH;
  const siteId = process.env.ALTWIRE_MATOMO_SITE_ID;

  if (!url || !token || !siteId) {
    return { configured: false, error: 'matomo_not_configured' };
  }
  return { configured: true, url: url.replace(/\/+$/, ''), token, siteId };
}

/**
 * Call a single Matomo Reporting API method.
 * @param {string} method  e.g. 'VisitsSummary.get'
 * @param {string} period  e.g. 'day', 'week', 'month'
 * @param {string} date    e.g. 'yesterday', '2024-06-15'
 * @param {object} [extraParams]  Additional Matomo API params (e.g. filter_pattern, filter_limit)
 * @returns {Promise<object>}
 */
async function callApi(method, period, date, extraParams = {}) {
  const cfg = getConfig();
  if (!cfg.configured) return cfg;

  const body = new URLSearchParams({
    module: 'API',
    method,
    idSite: cfg.siteId,
    period,
    date,
    format: 'JSON',
    token_auth: cfg.token,
    ...extraParams,
  });

  let response;
  try {
    response = await fetch(`${cfg.url}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch (err) {
    logger.error(`AltWire Matomo API request failed for ${method}`, { error: err.message });
    return { error: 'matomo_request_failed', message: err.message };
  }

  if (!response.ok) {
    logger.error(`AltWire Matomo API error for ${method}`, { status: response.status });
    return { error: 'matomo_api_error', status: response.status };
  }

  try {
    return await response.json();
  } catch {
    logger.error(`AltWire Matomo returned non-JSON response for ${method}`);
    return { error: 'matomo_invalid_response', message: 'Non-JSON response' };
  }
}

/**
 * Traffic summary: visits, unique visitors, pageviews, bounce rate.
 * Uses VisitsSummary.get.
 *
 * @param {string} period  e.g. 'day', 'week', 'month'
 * @param {string} date    e.g. 'yesterday', '2024-06-15'
 * @returns {Promise<object>}
 */
export async function getTrafficSummary(period, date) {
  const cfg = getConfig();
  if (!cfg.configured) return { error: cfg.error };

  // VisitsSummary.get has no pageview counts (only nb_actions) — merge in
  // Actions.get so nb_pageviews is available to the digest and synthesis.
  const [result, actions] = await Promise.all([
    callApi('VisitsSummary.get', period, date),
    callApi('Actions.get', period, date),
  ]);
  if (result.error) return result;

  if (!actions?.error) {
    if (result.nb_pageviews == null && actions.nb_pageviews != null) result.nb_pageviews = actions.nb_pageviews;
    if (result.nb_uniq_pageviews == null && actions.nb_uniq_pageviews != null) result.nb_uniq_pageviews = actions.nb_uniq_pageviews;
  }

  logger.info('AltWire Matomo traffic summary fetched', { period, date });
  return result;
}

/**
 * Top articles: most viewed articles (client-side filtered to exclude non-article pages).
 * Matomo filter_pattern only supports inclusion (rows must match), not exclusion,
 * so we fetch the full result and filter client-side.
 *
 * Excludes: homepage (/index), language redirects (/es, /fr, /de, /pt, /it), root (/).
 *
 * @param {string} period
 * @param {string} date
 * @param {number} [limit=20]
 * @returns {Promise<object>}
 */
export async function getTopArticles(period, date, limit = 20) {
  const cfg = getConfig();
  if (!cfg.configured) return { error: cfg.error };

  // Matomo returns 100 rows unless told otherwise; ask for enough that the
  // exclusion filter below still leaves `limit` articles.
  const filterLimit = Math.min(Math.max(limit * 2, 100), 1000);
  const result = await callApi('Actions.getPageUrls', period, date, { filter_limit: String(filterLimit) });
  if (result.error) return result;

  // Client-side exclusion filter: remove homepage, language redirects, root, system pages.
  // Matomo stores language variant pages at paths like /ru/, /es/, /fr/, etc.
  // Also filter out taxonomy pages (reviews, tag) and system pages.
  const EXCLUDE_LABELS = new Set([
    '/index', '/', 'es', 'fr', 'de', 'pt', 'it', 'ru',
    'reviews', 'tag', 'contact', 'about', 'home', 'search',
  ]);

  const filtered = Array.isArray(result)
    ? result.filter((r) => {
        const label = r.label ?? '';
        // Exclude root pages: homepage (/index), root (/), language codes at any path depth
        if (EXCLUDE_LABELS.has(label)) return false;
        // Exclude labels that start with /es/, /fr/, /de/, /pt/, /it/ (language redirects)
        if (/^\/(es|fr|de|pt|it)\//.test(label)) return false;
        return true;
      })
    : [];

  // Reconstruct full URL from label — Matomo returns path label (e.g.
  // 'album-review-tool-fear-inoculum' or '/album-review-tool-fear-inoculum').
  // DB stores full URLs like 'https://altwire.net/album-review-tool-fear-inoculum/'.
  const BASE_URL = 'https://altwire.net';

  const pages = filtered.slice(0, limit).map((item) => {
    const normalizedLabel = (item.label ?? '').replace(/^\//, '');
    return { ...item, url: `${BASE_URL}/${normalizedLabel}/` };
  });

  logger.info('AltWire Matomo top articles fetched', { period, date, count: pages.length });
  return pages;
}

/**
 * Top pages: most viewed, entry pages, exit pages.
 * Returns object with pageUrls array for compatibility.
 * Now excludes non-article pages via the same filtering as getTopArticles.
 *
 * @param {string} period
 * @param {string} date
 * @param {number} [limit=20]
 * @returns {Promise<object>}
 */
export async function getTopPages(period, date, limit = 20) {
  const pages = await getTopArticles(period, date, limit);
  if (pages.error) return pages;
  return { pageUrls: pages };
}

/**
 * Site search: keywords used on the internal search.
 * Uses Actions.getSiteSearchKeywords.
 *
 * @param {string} period
 * @param {string} date
 * @returns {Promise<object>}
 */
export async function getSiteSearchKeywords(period, date) {
  const cfg = getConfig();
  if (!cfg.configured) return { error: cfg.error };

  const result = await callApi('Actions.getSiteSearchKeywords', period, date);
  if (result.error) return result;

  logger.info('AltWire Matomo site search keywords fetched', { period, date });
  return result;
}

/**
 * Referrer breakdown: type, websites, campaigns.
 * Alias for compatibility with index.js expectations.
 *
 * @param {string} period
 * @param {string} date
 * @returns {Promise<object>}
 */
export async function getReferrerBreakdown(period, date) {
  const cfg = getConfig();
  if (!cfg.configured) return { error: cfg.error };

  const [types, websites, campaigns] = await Promise.all([
    callApi('Referrers.getReferrerType', period, date),
    callApi('Referrers.getWebsites', period, date),
    callApi('Referrers.getCampaigns', period, date),
  ]);

  logger.info('AltWire Matomo referrer breakdown fetched', { period, date });
  return { types, websites, campaigns };
}

/**
 * Site search — alias for getSiteSearchKeywords.
 *
 * @param {string} period
 * @param {string} date
 * @returns {Promise<object>}
 */
export async function getSiteSearch(period, date) {
  return getSiteSearchKeywords(period, date);
}

/**
 * Pageviews and visits for one URL over a date range (Actions.getPageUrl).
 * Tries the URL as given, then with/without its trailing slash, since
 * Matomo matches the exact URL it recorded.
 *
 * @returns {Promise<{ pageviews: number, visits: number, matched_url: string|null } | { error: string }>}
 */
export async function getPageUrlStats(pageUrl, startDate, endDate) {
  const cfg = getConfig();
  if (!cfg.configured) return { error: cfg.error };
  const variants = [pageUrl, pageUrl.endsWith('/') ? pageUrl.replace(/\/+$/, '') : `${pageUrl}/`];
  for (const url of variants) {
    const result = await callApi('Actions.getPageUrl', 'range', `${startDate},${endDate}`, { pageUrl: url });
    if (result?.error) return result;
    const rows = Array.isArray(result) ? result : [];
    if (rows.length) {
      return {
        pageviews: rows.reduce((s, r) => s + (r.nb_hits ?? 0), 0),
        visits: rows.reduce((s, r) => s + (r.nb_visits ?? 0), 0),
        matched_url: url,
      };
    }
  }
  return { pageviews: 0, visits: 0, matched_url: null };
}

/**
 * Site totals per calendar month for the last `months` months, including the
 * current partial month: { 'YYYY-MM': { visits, pageviews, unique_visitors } }.
 */
export async function getMonthlyTotals(months = 19) {
  const cfg = getConfig();
  if (!cfg.configured) return { error: cfg.error };
  const date = `last${months}`;
  const [visits, actions] = await Promise.all([
    callApi('VisitsSummary.get', 'month', date),
    callApi('Actions.get', 'month', date),
  ]);
  if (visits?.error) return visits;
  if (actions?.error) return actions;
  const out = {};
  for (const [month, v] of Object.entries(visits ?? {})) {
    const a = actions?.[month] ?? {};
    const row = Array.isArray(v) ? {} : v;
    out[month] = {
      visits: row.nb_visits ?? 0,
      unique_visitors: row.nb_uniq_visitors ?? null,
      pageviews: (Array.isArray(a) ? null : a.nb_pageviews) ?? 0,
    };
  }
  return out;
}
