/**
 * News Monitor handler — tracks GSC News search type data and
 * cross-references with Derek's watch list for coverage alerts.
 */

import pool, { hasDbConfig } from '../lib/altus-db.js';
import { logger } from '../logger.js';
import { getNewsSearchPerformance } from './altwire-gsc-client.js';
import { logAltusEvent } from '../altus-event-log.js';
import { upsertNewsOpportunityQueue } from './altus-opportunity-queue.js';

const NON_LATIN_QUERY_RE = /[\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Hebrew}\p{Script=Thai}\p{Script=Devanagari}]/u;
const ENGLISH_NEWS_TERMS = new Set([
  'album', 'announce', 'announced', 'band', 'cover', 'dates', 'ep', 'feature',
  'festival', 'interview', 'live', 'lyrics', 'music', 'new', 'news', 'premiere',
  'release', 'review', 'setlist', 'single', 'song', 'tour', 'track', 'video',
]);
const FOREIGN_SIGNAL_TERMS = new Set([
  'albumen', 'artista', 'avec', 'con', 'dans', 'das', 'del', 'der', 'des', 'die',
  'el', 'en', 'espanol', 'et', 'fuer', 'für', 'la', 'las', 'le', 'les', 'los',
  'mit', 'musik', 'nachrichten', 'noticias', 'nouvel', 'nuevo', 'para', 'por',
  'sur', 'und', 'una', 'uno', 'von',
]);

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

function tokenizeQuery(query) {
  return String(query)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .match(/[a-z]+/g) ?? [];
}

export function isLikelyEnglishNewsQuery(query) {
  if (typeof query !== 'string' || !query.trim()) return false;
  if (NON_LATIN_QUERY_RE.test(query)) return false;

  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) return false;

  const englishSignals = tokens.filter((token) => ENGLISH_NEWS_TERMS.has(token)).length;
  const foreignSignals = tokens.filter((token) => FOREIGN_SIGNAL_TERMS.has(token)).length;

  if (englishSignals > 0) return true;
  if (foreignSignals >= 2) return false;
  if (/[^\u0000-\u007F]/.test(query) && foreignSignals > 0) return false;

  return true;
}

/**
 * Fetch News opportunities — GSC News data cross-referenced with watch list.
 * @param {object} [params]
 * @param {number} [params.days=7] — Lookback window in days (1–30)
 * @returns {Promise<object>}
 */
export async function getNewsOpportunities({ days = 7 } = {}) {
  if (process.env.TEST_MODE === 'true') {
    return {
      success: true,
      test_mode: true,
      news_queries: [{ keys: ['test news query'], clicks: 10, impressions: 200, ctr: 0.05, position: 8 }],
      watch_list_matches: [{ query: 'test news query', matched_items: ['Test Artist'] }],
      news_pages: [{ keys: ['https://altwire.net/test/'], clicks: 5, impressions: 100, ctr: 0.05, position: 12 }],
    };
  }

  if (!hasDbConfig()) {
    return { error: 'Database not configured' };
  }

  // Compute date range — last N days
  const safeDays = Math.max(1, Math.min(30, days));
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(endDate.getDate() - safeDays);
  const startStr = startDate.toISOString().slice(0, 10);
  const endStr = endDate.toISOString().slice(0, 10);

  // Fetch News queries
  const queryResult = await getNewsSearchPerformance(startStr, endStr, { dimensions: ['query'], rowLimit: 50 });
  if (queryResult.error) return queryResult;

  // Fetch News pages
  const pageResult = await getNewsSearchPerformance(startStr, endStr, { dimensions: ['page'], rowLimit: 50 });

  const newsQueries = (queryResult.rows || []).filter((row) => isLikelyEnglishNewsQuery(row.keys?.[0]));
  const newsPages = pageResult.error ? [] : (pageResult.rows || []);

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
    const watchResult = await pool.query('SELECT name FROM altus_watch_list WHERE active = true');
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
  if (!hasDbConfig()) {
    logger.warn('News monitor cron: database URL not set — skipping');
    return;
  }

  logger.info('News monitor cron: starting');
  await logAltusEvent('cron_trigger', { payload: { cron_name: 'news_monitor', phase: 'started' } });

  try {
    const result = await getNewsOpportunities();
    if (result.error) {
      logger.error('News monitor cron: opportunities fetch failed', { error: result.error, message: result.message });
      await logAltusEvent('cron_trigger', {
        payload: {
          cron_name: 'news_monitor',
          phase: 'failed',
          error: result.error,
          message: result.message ?? null,
        },
      });
      return result;
    }

    // Key by America/New_York date so it matches how the digest reads it
    // (altus-digest.js). Using UTC here previously caused a day-boundary mismatch
    // where the digest looked up a key the cron had not written.
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const alertKey = `altus:news_alert:${today}`;

    await pool.query(
      `INSERT INTO agent_memory (agent, key, value) VALUES ($1, $2, $3)
       ON CONFLICT (agent, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      ['altus', alertKey, JSON.stringify(result)]
    );

    const queueResult = await upsertNewsOpportunityQueue(result);
    if (queueResult?.error) {
      logger.warn('News monitor cron: opportunity queue upsert failed', { error: queueResult.error });
    }

    logger.info('News monitor cron: completed', {
      newsQueries: result.news_queries?.length ?? 0,
      watchListMatches: result.watch_list_matches?.length ?? 0,
      queuedOpportunities: queueResult?.upserted ?? 0,
    });
    await logAltusEvent('cron_trigger', {
      payload: {
        cron_name: 'news_monitor',
        phase: 'completed',
        news_queries: result.news_queries?.length ?? 0,
        watch_list_matches: result.watch_list_matches?.length ?? 0,
        queued_opportunities: queueResult?.upserted ?? 0,
      },
    });
    return result;
  } catch (err) {
    logger.error('News monitor cron: failed', { error: err.message });
    await logAltusEvent('cron_trigger', {
      payload: {
        cron_name: 'news_monitor',
        phase: 'failed',
        error: err.message,
      },
    });
  }
}
