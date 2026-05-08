/**
 * handlers/altus-reflection.js
 *
 * Nightly reflection cron for AltWire editorial context.
 * Runs at 5 AM ET daily. Enriches reflection memory keys with:
 *   - hal:altwire:traffic_summary             (Matomo, fresh 7d/30d)
 *   - hal:altwire:top_articles                (Matomo, fresh 7d)
 *   - hal:altwire:site_search_keywords        (Matomo, fresh 7d)
 *   - hal:altwire:gsc:fresh_summary           (GSC, fresh 7d/28d)
 *   - hal:altwire:gsc:fresh_opportunities     (GSC, fresh 28d)
 *   - hal:altwire:combined_synthesis          (Matomo + GSC synthesis, 28d)
 *
 * Monthly (every 30 days): triggers historical re-seeds for both Matomo
 * (18-month) and GSC (16-month) memory keys.
 */

import { spawn } from 'child_process';
import { logger } from '../logger.js';
import { normalizeTopArticles } from '../lib/matomo-utils.js';
import { writeAgentMemory, readAgentMemory } from '../lib/altus-db.js';
import { getTrafficSummary, getTopArticles, getSiteSearchKeywords } from './altwire-matomo-client.js';
import {
  getSearchPerformance,
  getSearchOpportunities,
} from './altwire-gsc-client.js';
import { getCombinedAnalytics } from './altus-combined-analytics.js';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const LAST_REFRESHED_KEY = 'hal:altwire:analytics:last_refreshed';
const GSC_LAST_REFRESHED_KEY = 'hal:altwire:gsc:last_refreshed';

function isoDateOffset(daysBack) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysBack);
  return d.toISOString().slice(0, 10);
}

async function getLastRefreshTimestamp(key) {
  const result = await readAgentMemory('hal', key);
  if (!result.success) return null;
  try {
    return new Date(JSON.parse(result.value).timestamp);
  } catch {
    return null;
  }
}

async function shouldRefreshHistorical(key) {
  const last = await getLastRefreshTimestamp(key);
  if (!last || isNaN(last.getTime())) return true;
  return Date.now() - last.getTime() > THIRTY_DAYS_MS;
}

function spawnHistoricalSeed(scriptPath, force = false) {
  return new Promise((resolve) => {
    const args = [scriptPath];
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
        logger.info('altus-reflection: historical seed completed', { script: scriptPath });
        resolve(true);
      } else {
        logger.warn('altus-reflection: historical seed exited with code', { script: scriptPath, code, stderr });
        resolve(false);
      }
    });
    child.on('error', (err) => {
      logger.warn('altus-reflection: could not spawn historical seed script', { script: scriptPath, error: err.message });
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
    // Monthly historical refresh checks (independent for Matomo & GSC)
    if (await shouldRefreshHistorical(LAST_REFRESHED_KEY)) {
      logger.info('altus-reflection: Matomo historical analytics older than 30 days — triggering seed');
      await spawnHistoricalSeed('scripts/seed-altwire-historical-analytics.js', false);
    }
    if (await shouldRefreshHistorical(GSC_LAST_REFRESHED_KEY)) {
      logger.info('altus-reflection: GSC historical analytics older than 30 days — triggering seed');
      await spawnHistoricalSeed('scripts/seed-altwire-historical-gsc.js', false);
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
    const topArticles7dRaw = await getTopArticles('week', 'yesterday', 30);
    const wpBase = process.env.ALTWIRE_WP_URL ?? 'https://altwire.net';

    if (topArticles7dRaw?.error) {
      logger.warn('[altus-reflection] getTopArticles returned an error — skipping write to preserve prior data', { error: topArticles7dRaw.error });
    } else {
      const topArticles7d = normalizeTopArticles(topArticles7dRaw, wpBase);
      await writeAgentMemory('hal', 'hal:altwire:top_articles', JSON.stringify({
        period: '7d',
        articles: topArticles7d,
        generated_at: new Date().toISOString(),
      }));
    }

    // Site search keywords — what readers are searching for on AltWire
    const searchKeywords = await getSiteSearchKeywords('week', 'yesterday');
    await writeAgentMemory('hal', 'hal:altwire:site_search_keywords', JSON.stringify({
      keywords: searchKeywords,
      period: '7d',
      generated_at: new Date().toISOString(),
    }));

    // GSC fresh summary — 7d and 28d
    const gscEnd = isoDateOffset(3);
    const gscStart7 = isoDateOffset(10);
    const gscStart28 = isoDateOffset(31);
    const [gscFresh7, gscFresh28, gscOpps] = await Promise.allSettled([
      getSearchPerformance(gscStart7, gscEnd, { rowLimit: 25 }),
      getSearchPerformance(gscStart28, gscEnd, { rowLimit: 50 }),
      getSearchOpportunities(gscStart28, gscEnd),
    ]);
    await writeAgentMemory('hal', 'hal:altwire:gsc:fresh_summary', JSON.stringify({
      period_7d: gscFresh7.status === 'fulfilled' ? gscFresh7.value : { error: gscFresh7.reason?.message },
      period_28d: gscFresh28.status === 'fulfilled' ? gscFresh28.value : { error: gscFresh28.reason?.message },
      generated_at: new Date().toISOString(),
    }));
    await writeAgentMemory('hal', 'hal:altwire:gsc:fresh_opportunities', JSON.stringify({
      period_28d: gscOpps.status === 'fulfilled' ? gscOpps.value : { error: gscOpps.reason?.message },
      generated_at: new Date().toISOString(),
    }));

    // Combined Matomo + GSC synthesis — 28-day picture
    try {
      const combined = await getCombinedAnalytics({
        startDate: gscStart28,
        endDate: gscEnd,
        synthesize: true,
      });
      await writeAgentMemory('hal', 'hal:altwire:combined_synthesis', JSON.stringify(combined));
    } catch (err) {
      logger.warn('altus-reflection: combined synthesis failed', { error: err.message });
    }

    logger.info('altus-reflection: completed');
  } catch (err) {
    logger.error('altus-reflection: error', { error: err.message });
    throw err;
  }
}