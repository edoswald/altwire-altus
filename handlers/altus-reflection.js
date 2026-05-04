/**
 * handlers/altus-reflection.js
 *
 * Nightly reflection cron for AltWire editorial context.
 * Runs at 5 AM ET daily. Enriches reflection memory keys with:
 *   - hal:altwire:traffic_summary
 *   - hal:altwire:top_articles
 *   - hal:altwire:site_search_keywords
 *   - hal:altwire:editorial_signals
 *
 * This is a lightweight editorial reflection — not the full nimbus reflection.
 * GSC-based keys (search_opportunities, content_gaps) are separate and
 * require altwire-gsc-client.js which is not yet implemented.
 */

import { logger } from '../logger.js';
import { writeAgentMemory } from '../lib/altus-db.js';
import { getTrafficSummary, getTopArticles, getSiteSearchKeywords } from './altwire-matomo-client.js';

/**
 * Run the nightly AltWire reflection.
 * @returns {Promise<void>}
 */
export async function runAltwireReflection() {
  logger.info('altus-reflection: starting');

  try {
    // Traffic summary — 7d and 30d
    const traffic7d = await getTrafficSummary('week', 'yesterday');
    const traffic30d = await getTrafficSummary('month', 'yesterday');

    await writeAgentMemory('hal', 'hal:altwire:traffic_summary', JSON.stringify({
      period_7d: traffic7d,
      period_30d: traffic30d,
      generated_at: new Date().toISOString(),
    }));

    // Top articles — 7d (most viewed)
    const topArticles7d = await getTopArticles('week', 'yesterday', 20);
    await writeAgentMemory('hal', 'hal:altwire:top_articles', JSON.stringify({
      period: '7d',
      articles: topArticles7d,
      generated_at: new Date().toISOString(),
    }));

    // Site search keywords — what readers are searching for on AltWire
    const searchKeywords = await getSiteSearchKeywords('week', 'yesterday');
    await writeAgentMemory('hal', 'hal:altwire:site_search_keywords', JSON.stringify({
      keywords: searchKeywords,
      period: '7d',
      generated_at: new Date().toISOString(),
    }));

    logger.info('altus-reflection: completed');
  } catch (err) {
    logger.error('altus-reflection: error', { error: err.message });
    throw err;
  }
}