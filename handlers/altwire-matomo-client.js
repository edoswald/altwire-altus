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

  const result = await callApi('VisitsSummary.get', period, date);
  if (result.error) return result;

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

  const result = await callApi('Actions.getPageUrls', period, date);
  if (result.error) return result;

  // Client-side exclusion filter: remove homepage, language redirects, root, system pages.
  const EXCLUDE_LABELS = new Set(['/index', '/', 'es', 'fr', 'de', 'pt', 'it']);

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

  // Reconstruct full URL from label — Matomo doesn't return the full URL, only the path.
  // The DB stores full URLs like https://altwire.net/album-review-tool-fear-inoculum/
  const BASE_URL = 'https://www.altwire.net';

  const pages = filtered.slice(0, limit).map((r) => ({
    ...r,
    url: `${BASE_URL}${r.label}`,
  }));

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