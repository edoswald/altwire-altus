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
 * Monthly (every 30 days): triggers a full historical analytics re-seed
 * via scripts/seed-altwire-historical-analytics.js to keep 18-month
 * analytics memory keys fresh.
 *
 * This is a lightweight editorial reflection — not the full nimbus reflection.
 * GSC-based keys (search_opportunities, content_gaps) are separate and
 * require altwire-gsc-client.js which is not yet implemented.
 */

import { spawn } from 'child_process';
import { logger } from '../logger.js';
import { writeAgentMemory, readAgentMemory } from '../lib/altus-db.js';
import { getTrafficSummary, getTopArticles, getSiteSearchKeywords } from './altwire-matomo-client.js';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const LAST_REFRESHED_KEY = 'hal:altwire:analytics:last_refreshed';

async function getLastHistoricalRefresh() {
  const result = await readAgentMemory('hal', LAST_REFRESHED_KEY);
  if (!result.success) return null;
  try {
    return new Date(JSON.parse(result.value).timestamp);
  } catch {
    return null;
  }
}

async function shouldRefreshHistoricalAnalytics() {
  const last = await getLastHistoricalRefresh();
  if (!last) return true;
  return Date.now() - last.getTime() > THIRTY_DAYS_MS;
}

function spawnHistoricalSeed(force = false) {
  return new Promise((resolve) => {
    const args = ['scripts/seed-altwire-historical-analytics.js'];
    if (force) args.push('--force');
    const child = spawn('node', args, {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('close', (code) => {
      if (code === 0) {
        logger.info('altus-reflection: historical analytics seed completed');
        resolve(true);
      } else {
        logger.warn('altus-reflection: historical analytics seed exited with code', { code, stderr });
        resolve(false);
      }
    });
    child.on('error', (err) => {
      logger.warn('altus-reflection: could not spawn historical seed script', { error: err.message });
      resolve(false);
    });
  });
}

/**
 * Run the nightly AltWire reflection.
 * @returns {Promise<void>}
 */
export async function runAltwireReflection() {
  logger.info('altus-reflection: starting');

  try {
    // Monthly historical analytics refresh check
    if (await shouldRefreshHistoricalAnalytics()) {
      logger.info('altus-reflection: historical analytics older than 30 days — triggering seed');
      await spawnHistoricalSeed(false);
    }

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