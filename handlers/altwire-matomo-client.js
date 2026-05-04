/**
 * Matomo Reporting API client for AltWire.
 *
 * Reads ALTWIRE_MATOMO_URL, ALTWIRE_MATOMO_TOKEN_AUTH, ALTWIRE_MATOMO_SITE_ID from environment.
 * Returns structured error when env vars are missing.
 * All functions use async fetch() exclusively.
 */

import { logger } from './logger.js';

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
 * Top pages: most viewed articles.
 * Uses Actions.getPageUrls.
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

  const pages = Array.isArray(result) ? result.slice(0, limit) : [];
  logger.info('AltWire Matomo top articles fetched', { period, date, count: pages.length });
  return pages;
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