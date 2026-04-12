/**
 * News Monitor handler — tracks GSC News search type data and
 * cross-references with Derek's watch list for coverage alerts.
 */

import pool from '../lib/altus-db.js';
import { logger } from '../logger.js';
import { getNewsSearchPerformance } from './altwire-gsc-client.js';

/**
 * Case-insensitive substring watch list matching.
 * @param {string} query — News query string
 * @param {Array<{ name: string }>} watchItems — watch list items
 * @returns {string[]} — matching watch item names
 */
export function matchesWatchList(query, watchItems) {
  const lowerQuery = query.toLowerCase();
  return watchItems
    .filter((item) => lowerQuery.includes(item.name.toLowerCase()))
    .map((item) => item.name);
}

/**
 * Fetch News opportunities — GSC News data cross-referenced with watch list.
 * @returns {Promise<object>}
 */
export async function getNewsOpportunities() {
  if (process.env.TEST_MODE === 'true') {
    return {
      success: true,
      test_mode: true,
      news_queries: [{ keys: ['test news query'], clicks: 10, impressions: 200, ctr: 0.05, position: 8 }],
      watch_list_matches: [{ query: 'test news query', matched_items: ['Test Artist'] }],
      news_pages: [{ keys: ['https://altwire.net/test/'], clicks: 5, impressions: 100, ctr: 0.05, position: 12 }],
    };
  }

  if (!process.env.DATABASE_URL) {
    return { error: 'Database not configured' };
  }

  // Compute date range — last 7 days
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(endDate.getDate() - 7);
  const startStr = startDate.toISOString().slice(0, 10);
  const endStr = endDate.toISOString().slice(0, 10);

  // Fetch News queries
  const queryResult = await getNewsSearchPerformance(startStr, endStr, { dimensions: ['query'], rowLimit: 50 });
  if (queryResult.error) return queryResult;

  // Fetch News pages
  const pageResult = await getNewsSearchPerformance(startStr, endStr, { dimensions: ['page'], rowLimit: 50 });

  const newsQueries = queryResult.rows || [];
  const newsPages = (pageResult.rows || pageResult.error) ? (pageResult.rows || []) : [];

  if (newsQueries.length === 0 && newsPages.length === 0) {
    return {
      news_queries: [],
      watch_list_matches: [],
      news_pages: [],
      note: 'No Google News data available — News coverage may be sparse initially',
    };
  }

  // Cross-reference with watch list
  let watchItems = [];
  let watchListNote = null;
  try {
    const watchResult = await pool.query('SELECT name FROM altus_watch_list');
    watchItems = watchResult.rows;
  } catch (err) {
    // Table may not exist — graceful handling
    logger.warn('Watch list query failed — table may not exist', { error: err.message });
    watchListNote = 'Watch list not available — table may not exist yet';
  }

  let watchListMatches = [];
  if (watchItems.length > 0) {
    for (const row of newsQueries) {
      const query = row.keys[0];
      const matched = matchesWatchList(query, watchItems);
      if (matched.length > 0) {
        watchListMatches.push({ query, matched_items: matched, impressions: row.impressions, clicks: row.clicks });
      }
    }
  } else if (!watchListNote) {
    watchListNote = 'Watch list is empty — add items to altus_watch_list for cross-referencing';
  }

  const result = {
    news_queries: newsQueries,
    watch_list_matches: watchListMatches,
    news_pages: newsPages,
  };
  if (watchListNote) result.watch_list_note = watchListNote;

  return result;
}

/**
 * Run the daily news monitor check (called by cron).
 * Stores alert in agent_memory. Never throws.
 * @returns {Promise<void>}
 */
export async function runNewsMonitorCron() {
  if (!process.env.DATABASE_URL) {
    logger.warn('News monitor cron: DATABASE_URL not set — skipping');
    return;
  }

  logger.info('News monitor cron: starting');

  try {
    const result = await getNewsOpportunities();
    const today = new Date().toISOString().slice(0, 10);
    const alertKey = `altus:news_alert:${today}`;

    await pool.query(
      `INSERT INTO agent_memory (agent, key, value) VALUES ($1, $2, $3)
       ON CONFLICT (agent, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      ['altus', alertKey, JSON.stringify(result)]
    );

    logger.info('News monitor cron: completed', {
      newsQueries: result.news_queries?.length ?? 0,
      watchListMatches: result.watch_list_matches?.length ?? 0,
    });
  } catch (err) {
    logger.error('News monitor cron: failed', { error: err.message });
  }
}
