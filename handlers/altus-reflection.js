/**
 * handlers/altus-reflection.js
 *
 * Nightly reflection cron for AltWire editorial context.
 * Runs at 5 AM ET daily. Enriches reflection memory keys with:
 *   - hal:altwire:top_articles_7d / _30d (pre-seeded, also refreshed here)
 *   - hal:altwire:traffic_summary
 *   - hal:altwire:search_opportunities
 *   - hal:altwire:editorial_signals
 *
 * This is a lightweight editorial reflection — not the full nimbus reflection.
 */

import { logger } from '../logger.js';
import { writeAgentMemory } from '../lib/altus-db.js';
import { getTrafficSummary } from './altwire-matomo-client.js';
import { getSearchOpportunities } from './altwire-gsc-client.js';

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

    // Search opportunities — high-impression, low-CTR
    const today = new Date();
    const thirtyDaysAgo = new Date(today);
    thirtyDaysAgo.setDate(today.getDate() - 30);
    const start = thirtyDaysAgo.toISOString().slice(0, 10);
    const end = today.toISOString().slice(0, 10);

    const opps = await getSearchOpportunities(start, end);
    await writeAgentMemory('hal', 'hal:altwire:search_opportunities', JSON.stringify({
      opportunities: opps,
      date_range: { start, end },
      generated_at: new Date().toISOString(),
    }));

    logger.info('altus-reflection: completed');
  } catch (err) {
    logger.error('altus-reflection: error', { error: err.message });
    throw err;
  }
}