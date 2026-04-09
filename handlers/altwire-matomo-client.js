/**
 * Matomo Reporting API client.
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
 * @returns {Promise<object>}
 */
async function callApi(method, period, date) {
  const cfg = getConfig();
  if (!cfg.configured) return cfg;

  // POST the token in the request body instead of the query string.
  // Matomo rejects GET-based token_auth when the token has
  // "Only allow secure requests" enabled (returns 401).
  const body = new URLSearchParams({
    module: 'API',
    method,
    idSite: cfg.siteId,
    period,
    date,
    format: 'JSON',
    token_auth: cfg.token,
  });

  let response;
  try {
    response = await fetch(`${cfg.url}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch (err) {
    logger.error(`Matomo API request failed for ${method}`, { error: err.message });
    return { error: 'matomo_request_failed', message: err.message };
  }

  if (!response.ok) {
    logger.error(`Matomo API error for ${method}`, { status: response.status });
    return { error: 'matomo_api_error', status: response.status };
  }

  try {
    return await response.json();
  } catch {
    logger.error(`Matomo returned non-JSON response for ${method}`);
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

  logger.info('Matomo traffic summary fetched', { period, date });
  return result;
}

/**
 * Referrer breakdown: type, websites, campaigns.
 * Calls Referrers.getReferrerType, Referrers.getWebsites, Referrers.getCampaigns.
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

  if (types.error || websites.error || campaigns.error) {
    logger.warn('Matomo referrer breakdown partial failure', {
      typesError: types.error ?? null,
      websitesError: websites.error ?? null,
      campaignsError: campaigns.error ?? null,
    });
  }

  logger.info('Matomo referrer breakdown fetched', { period, date });
  return { types, websites, campaigns };
}

/**
 * Top pages: most viewed, entry pages, exit pages.
 * Calls Actions.getPageUrls, Actions.getEntryPageUrls, Actions.getExitPageUrls.
 *
 * @param {string} period
 * @param {string} date
 * @returns {Promise<object>}
 */
export async function getTopPages(period, date) {
  const cfg = getConfig();
  if (!cfg.configured) return { error: cfg.error };

  const [pageUrls, entryPages, exitPages] = await Promise.all([
    callApi('Actions.getPageUrls', period, date),
    callApi('Actions.getEntryPageUrls', period, date),
    callApi('Actions.getExitPageUrls', period, date),
  ]);

  if (pageUrls.error || entryPages.error || exitPages.error) {
    logger.warn('Matomo top pages partial failure', {
      pageUrlsError: pageUrls.error ?? null,
      entryPagesError: entryPages.error ?? null,
      exitPagesError: exitPages.error ?? null,
    });
  }

  logger.info('Matomo top pages fetched', { period, date });
  return { pageUrls, entryPages, exitPages };
}

/**
 * Site search: keywords and no-result keywords.
 * Calls Actions.getSiteSearchKeywords, Actions.getSiteSearchNoResultKeywords.
 *
 * @param {string} period
 * @param {string} date
 * @returns {Promise<object>}
 */
export async function getSiteSearch(period, date) {
  const cfg = getConfig();
  if (!cfg.configured) return { error: cfg.error };

  const [keywords, noResultKeywords] = await Promise.all([
    callApi('Actions.getSiteSearchKeywords', period, date),
    callApi('Actions.getSiteSearchNoResultKeywords', period, date),
  ]);

  if (keywords.error || noResultKeywords.error) {
    logger.warn('Matomo site search partial failure', {
      keywordsError: keywords.error ?? null,
      noResultError: noResultKeywords.error ?? null,
    });
  }

  logger.info('Matomo site search fetched', { period, date });
  return { keywords, noResultKeywords };
}
