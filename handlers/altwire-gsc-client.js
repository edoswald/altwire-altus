/**
 * Google Search Console client — AltWire / Altus edition.
 *
 * Adapted from cirrusly-nimbus/gsc-client.js with ALTWIRE_-prefixed env vars.
 * Uses the `googleapis` npm package with service account authentication.
 * Reads ALTWIRE_GSC_SERVICE_ACCOUNT_JSON and ALTWIRE_GSC_SITE_URL from environment.
 * Returns structured error when env vars are missing.
 * All async functions return structured objects, never throw.
 */

import { google } from 'googleapis';
import { logger } from '../logger.js';

/**
 * Strip trailing slashes from a URL string.
 * Non-string inputs are returned as-is.
 * @param {*} url
 * @returns {*}
 */
export function normalizeUrl(url) {
  if (typeof url !== 'string') return url;
  return url.replace(/\/+$/, '');
}

/**
 * Check that all required GSC env vars are present and return a configured auth client.
 * @returns {{ configured: true, auth: object, siteUrl: string } | { configured: false, error: string }}
 */
function getConfig() {
  const serviceAccountJson = process.env.ALTWIRE_GSC_SERVICE_ACCOUNT_JSON;
  const siteUrl = process.env.ALTWIRE_GSC_SITE_URL;

  if (!serviceAccountJson || !siteUrl) {
    return { configured: false, error: 'gsc_not_configured' };
  }

  let credentials;
  try {
    credentials = JSON.parse(serviceAccountJson);
  } catch (err) {
    logger.error('ALTWIRE_GSC_SERVICE_ACCOUNT_JSON is not valid JSON', { error: err.message });
    return { configured: false, error: 'gsc_not_configured' };
  }

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
  });

  return { configured: true, auth, siteUrl };
}

/**
 * Normalize a `dimensions` value into a proper JS array of strings.
 *
 * - Array → returned as-is
 * - String → try JSON.parse; if result is an array return it, else wrap in [string].
 *   Empty string falls back to ['query'].
 * - Any other type (undefined, null, number, etc.) → ['query']
 *
 * @param {*} dimensions
 * @returns {string[]}
 */
export function normalizeDimensions(dimensions) {
  if (Array.isArray(dimensions)) return dimensions;

  if (typeof dimensions === 'string') {
    if (dimensions === '') return ['query'];
    try {
      const parsed = JSON.parse(dimensions);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // not valid JSON — fall through to wrap
    }
    return [dimensions];
  }

  return ['query'];
}

/**
 * Search performance: queries, impressions, clicks, CTR, average position.
 *
 * @param {string} startDate  ISO date string e.g. '2024-06-01'
 * @param {string} endDate    ISO date string e.g. '2024-06-30'
 * @param {object} [options]
 * @param {number} [options.rowLimit=25]              Max rows to return
 * @param {string[]} [options.dimensions=['query']]   Dimensions to group by
 * @returns {Promise<object>}
 */
export async function getSearchPerformance(startDate, endDate, options = {}) {
  const cfg = getConfig();
  if (!cfg.configured) return { error: cfg.error };

  const { rowLimit = 25, dimensions = ['query'] } = options;
  const normalizedDimensions = normalizeDimensions(dimensions);

  try {
    const searchconsole = google.searchconsole({ version: 'v1', auth: cfg.auth });

    logger.info('GSC search performance request', { startDate, endDate, siteUrl: cfg.siteUrl });

    const response = await searchconsole.searchanalytics.query({
      siteUrl: cfg.siteUrl,
      requestBody: {
        startDate,
        endDate,
        dimensions: normalizedDimensions,
        rowLimit,
        dataState: 'all',
      },
    });

    const rows = response.data.rows ?? [];

    logger.info('GSC search performance fetched', {
      startDate,
      endDate,
      rowCount: rows.length,
    });

    return {
      startDate,
      endDate,
      dimensions: normalizedDimensions,
      rows: rows.map((row) => ({
        keys: row.keys,
        clicks: row.clicks,
        impressions: row.impressions,
        ctr: row.ctr,
        position: row.position,
      })),
    };
  } catch (err) {
    logger.error('GSC search performance query failed', { error: err.message });
    return { error: 'gsc_api_error', message: err.message };
  }
}

/**
 * Sitemap health: fetch status, error counts, and last download timestamps.
 * Uses webmasters.sitemaps.list.
 *
 * @returns {Promise<object>}
 */
export async function getSitemapHealth() {
  const cfg = getConfig();
  if (!cfg.configured) return { error: cfg.error };

  try {
    const webmasters = google.webmasters({ version: 'v3', auth: cfg.auth });

    const response = await webmasters.sitemaps.list({
      siteUrl: cfg.siteUrl,
    });

    const sitemaps = (response.data.sitemap ?? []).map((s) => ({
      path: s.path,
      lastDownloaded: s.lastDownloaded ?? null,
      lastSubmitted: s.lastSubmitted ?? null,
      isPending: s.isPending ?? false,
      errors: s.errors ?? 0,
      warnings: s.warnings ?? 0,
    }));

    logger.info('GSC sitemap health fetched', {
      siteUrl: cfg.siteUrl,
      sitemapCount: sitemaps.length,
    });

    return {
      siteUrl: cfg.siteUrl,
      sitemaps,
    };
  } catch (err) {
    logger.error('GSC sitemap health query failed', { error: err.message });
    return { error: 'gsc_api_error', message: err.message };
  }
}

/**
 * Search opportunities: high-impression, low-CTR keywords for optimization.
 *
 * Fetches top queries by impressions and filters to those with CTR below
 * the median CTR, surfacing keywords that get visibility but few clicks.
 *
 * @param {string} startDate  ISO date string e.g. '2024-06-01'
 * @param {string} endDate    ISO date string e.g. '2024-06-30'
 * @returns {Promise<object>}
 */
export async function getSearchOpportunities(startDate, endDate) {
  const cfg = getConfig();
  if (!cfg.configured) return { error: cfg.error };

  try {
    const searchconsole = google.searchconsole({ version: 'v1', auth: cfg.auth });

    logger.info('GSC search opportunities request', { startDate, endDate, siteUrl: cfg.siteUrl });

    const response = await searchconsole.searchanalytics.query({
      siteUrl: cfg.siteUrl,
      requestBody: {
        startDate,
        endDate,
        dimensions: ['query'],
        rowLimit: 100,
        orderBy: [{ fieldName: 'impressions', sortOrder: 'DESCENDING' }],
        dataState: 'all',
      },
    });

    const rows = response.data.rows ?? [];

    if (rows.length === 0) {
      logger.info('GSC search opportunities: no data', { startDate, endDate });
      return { startDate, endDate, opportunities: [] };
    }

    // Compute median CTR to identify below-median performers
    const ctrs = rows.map((r) => r.ctr).sort((a, b) => a - b);
    const mid = Math.floor(ctrs.length / 2);
    const medianCtr = ctrs.length % 2 !== 0
      ? ctrs[mid]
      : (ctrs[mid - 1] + ctrs[mid]) / 2;

    // Opportunities: impressions above median AND CTR below median
    const sortedImpressions = rows.map((r) => r.impressions).sort((a, b) => a - b);
    const midImp = Math.floor(sortedImpressions.length / 2);
    const medianImpressions = sortedImpressions.length % 2 !== 0
      ? sortedImpressions[midImp]
      : (sortedImpressions[midImp - 1] + sortedImpressions[midImp]) / 2;

    const opportunities = rows
      .filter((r) => r.impressions >= medianImpressions && r.ctr < medianCtr)
      .map((row) => ({
        query: row.keys[0],
        clicks: row.clicks,
        impressions: row.impressions,
        ctr: row.ctr,
        position: row.position,
      }));

    logger.info('GSC search opportunities computed', {
      startDate,
      endDate,
      totalRows: rows.length,
      opportunityCount: opportunities.length,
      medianCtr,
    });

    return {
      startDate,
      endDate,
      medianCtr,
      opportunities,
    };
  } catch (err) {
    logger.error('GSC search opportunities query failed', { error: err.message });
    return { error: 'gsc_api_error', message: err.message };
  }
}

/**
 * News search type performance: queries/pages appearing in Google News results.
 *
 * @param {string} startDate  ISO date string
 * @param {string} endDate    ISO date string
 * @param {object} [options]
 * @param {number} [options.rowLimit=25]              Max rows to return
 * @param {string[]} [options.dimensions=['query']]   Dimensions to group by
 * @returns {Promise<object>}
 */
export async function getNewsSearchPerformance(startDate, endDate, options = {}) {
  const cfg = getConfig();
  if (!cfg.configured) return { error: cfg.error };

  const { rowLimit = 25, dimensions = ['query'] } = options;
  const normalizedDimensions = normalizeDimensions(dimensions);

  try {
    const searchconsole = google.searchconsole({ version: 'v1', auth: cfg.auth });

    logger.info('GSC News search performance request', { startDate, endDate, siteUrl: cfg.siteUrl });

    const response = await searchconsole.searchanalytics.query({
      siteUrl: cfg.siteUrl,
      requestBody: {
        startDate,
        endDate,
        searchType: 'news',
        dimensions: normalizedDimensions,
        rowLimit,
        dataState: 'all',
      },
    });

    const rows = response.data.rows ?? [];

    if (rows.length === 0) {
      return {
        startDate,
        endDate,
        rows: [],
        note: 'No Google News data for this period — News coverage may be sparse initially',
      };
    }

    logger.info('GSC News search performance fetched', {
      startDate,
      endDate,
      rowCount: rows.length,
    });

    return {
      startDate,
      endDate,
      rows: rows.map((row) => ({
        keys: row.keys,
        clicks: row.clicks,
        impressions: row.impressions,
        ctr: row.ctr,
        position: row.position,
      })),
    };
  } catch (err) {
    logger.error('GSC News search performance query failed', { error: err.message });
    return { error: 'gsc_api_error', message: err.message };
  }
}

/**
 * Opportunity zone queries: position 5–30 range, sorted by impressions.
 *
 * @param {string} startDate  ISO date string
 * @param {string} endDate    ISO date string
 * @returns {Promise<object>}
 */
export async function getOpportunityZoneQueries(startDate, endDate) {
  const cfg = getConfig();
  if (!cfg.configured) return { error: cfg.error };

  try {
    const searchconsole = google.searchconsole({ version: 'v1', auth: cfg.auth });

    logger.info('GSC opportunity zone queries request', { startDate, endDate, siteUrl: cfg.siteUrl });

    const response = await searchconsole.searchanalytics.query({
      siteUrl: cfg.siteUrl,
      requestBody: {
        startDate,
        endDate,
        dimensions: ['query', 'page'],
        dimensionFilterGroups: [{
          filters: [
            { dimension: 'query', operator: 'notContains', expression: '' },
          ],
        }],
        rowLimit: 100,
        orderBy: [{ fieldName: 'impressions', sortOrder: 'DESCENDING' }],
        dataState: 'all',
      },
    });

    const rows = (response.data.rows ?? [])
      .filter((row) => row.position >= 5 && row.position <= 30);

    if (rows.length === 0) {
      return {
        startDate,
        endDate,
        rows: [],
        note: 'No queries found in position 5-30 range',
      };
    }

    logger.info('GSC opportunity zone queries fetched', {
      startDate,
      endDate,
      rowCount: rows.length,
    });

    return {
      startDate,
      endDate,
      rows: rows.map((row) => ({
        keys: row.keys,
        clicks: row.clicks,
        impressions: row.impressions,
        ctr: row.ctr,
        position: row.position,
      })),
    };
  } catch (err) {
    logger.error('GSC opportunity zone queries failed', { error: err.message });
    return { error: 'gsc_api_error', message: err.message };
  }
}

/**
 * Aggregate performance for a specific page URL.
 *
 * @param {string} pageUrl   Full URL (trailing slash stripped internally)
 * @param {string} startDate ISO date string
 * @param {string} endDate   ISO date string
 * @returns {Promise<object>}
 */
export async function getPagePerformance(pageUrl, startDate, endDate) {
  const cfg = getConfig();
  if (!cfg.configured) return { error: cfg.error };

  const normalized = normalizeUrl(pageUrl);

  try {
    const searchconsole = google.searchconsole({ version: 'v1', auth: cfg.auth });

    logger.info('GSC page performance request', { pageUrl: normalized, startDate, endDate });

    const response = await searchconsole.searchanalytics.query({
      siteUrl: cfg.siteUrl,
      requestBody: {
        startDate,
        endDate,
        dimensionFilterGroups: [{
          filters: [{
            dimension: 'page',
            operator: 'equals',
            expression: normalized,
          }],
        }],
        dataState: 'all',
      },
    });

    const rows = response.data.rows ?? [];

    if (rows.length === 0) {
      return {
        pageUrl: normalized,
        clicks: 0,
        impressions: 0,
        ctr: 0,
        position: null,
        note: 'No GSC data for this URL in the specified period',
      };
    }

    const row = rows[0];
    return {
      pageUrl: normalized,
      clicks: row.clicks,
      impressions: row.impressions,
      ctr: row.ctr,
      position: row.position,
    };
  } catch (err) {
    logger.error('GSC page performance query failed', { error: err.message });
    return { error: 'gsc_api_error', message: err.message };
  }
}
