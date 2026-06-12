/**
 * handlers/altus-reflection.js
 *
 * Nightly reflection cron for AltWire editorial context.
 * Runs at 4 AM ET daily. Enriches reflection memory keys with:
 *   - hal:altwire:traffic_summary             (Matomo, fresh 7d/30d)
 *   - hal:altwire:top_articles                (Matomo, fresh 7d)
 *   - hal:altwire:site_search_keywords        (Matomo, fresh 7d)
 *   - hal:altwire:gsc:fresh_summary           (GSC, fresh 7d/28d)
 *   - hal:altwire:gsc:fresh_opportunities     (GSC, fresh 28d)
 *   - hal:altwire:combined_synthesis          (Matomo + GSC synthesis, 28d)
 *
 * Also:
 *   - Reads today's news monitor alert (watch list matches) and incorporates
 *     them into the synthesis context written for Hal.
 *   - Runs a proposer pass: converts content_gaps and opportunity_alignments
 *     from the synthesis into altus_action_items (editorial category).
 *
 * Monthly (every 30 days): triggers historical re-seeds for both Matomo
 * (18-month) and GSC (16-month) memory keys.
 */

import pool from '../lib/altus-db.js';
import { spawn } from 'child_process';
import { getLagAwareGscWindow, isoDateOffset } from '../lib/gsc-date-window.js';
import { logger } from '../logger.js';
import { normalizeTopArticles } from '../lib/matomo-utils.js';
import { writeAgentMemory, readAgentMemory } from '../lib/altus-db.js';
import { getTrafficSummary, getTopArticles, getSiteSearchKeywords } from './altwire-matomo-client.js';
import {
  getSearchPerformance,
  getSearchOpportunities,
} from './altwire-gsc-client.js';
import { getCombinedAnalytics, recordSynthesisFeatures } from './altus-combined-analytics.js';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const LAST_REFRESHED_KEY = 'hal:altwire:analytics:last_refreshed';
const GSC_LAST_REFRESHED_KEY = 'hal:altwire:gsc:last_refreshed';

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
 * Read today's news monitor alert from agent_memory.
 * Returns the parsed alert or null if not available.
 * @returns {Promise<object|null>}
 */
async function loadTodaysNewsAlert() {
  const today = new Date().toISOString().slice(0, 10);
  const result = await readAgentMemory('altus', `altus:news_alert:${today}`);
  if (!result.success) return null;
  try {
    return JSON.parse(result.value);
  } catch {
    return null;
  }
}

/**
 * Create action items from the AI synthesis output.
 * Inserts editorial-category items for content gaps and SEO opportunity alignments.
 * Deduplicates by signal_source + title to prevent re-creation on the same day.
 *
 * @param {object} synthesis — the synthesis sub-field from getCombinedAnalytics result
 * @param {string} reflectionDate — ISO date string (YYYY-MM-DD)
 * @returns {Promise<number>} — count of items created
 */
export async function proposeEditorialActionItems(synthesis, reflectionDate) {
  if (!synthesis) return 0;

  const candidates = [];

  for (const gap of synthesis.content_gaps ?? []) {
    if (!gap.query) continue;
    candidates.push({
      title: `Cover content gap: "${gap.query}"`,
      description: gap.rationale
        ? `GSC shows demand for "${gap.query}" (${gap.impressions ?? '?'} impressions) with no AltWire coverage. ${gap.rationale}`
        : `GSC shows search demand for "${gap.query}" (${gap.impressions ?? '?'} impressions) but no matching AltWire content.`,
      signal_source: 'reflection:content_gap',
    });
  }

  for (const opp of synthesis.opportunity_alignments ?? []) {
    if (!opp.query) continue;
    candidates.push({
      title: `SEO opportunity: "${opp.query}"`,
      description: opp.recommendation
        ? `Opportunity zone query aligned with reader interest. ${opp.recommendation}`
        : `"${opp.query}" is in the GSC opportunity zone and matches on-site reader interest.`,
      signal_source: 'reflection:seo_opportunity',
    });
  }

  if (candidates.length === 0) return 0;

  let created = 0;
  for (const c of candidates) {
    try {
      // Deduplicate: skip if an identical title was already proposed today
      const existing = await pool.query(
        `SELECT id FROM altus_action_items
         WHERE title = $1 AND reflection_date = $2 AND status != 'dismissed'
         LIMIT 1`,
        [c.title, reflectionDate],
      );
      if (existing.rows.length > 0) continue;

      await pool.query(
        `INSERT INTO altus_action_items (title, description, category, signal_source, reflection_date)
         VALUES ($1, $2, 'editorial', $3, $4)`,
        [c.title, c.description, c.signal_source, reflectionDate],
      );
      created++;
    } catch (err) {
      logger.warn('altus-reflection: failed to create action item', { title: c.title, error: err.message });
    }
  }

  return created;
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
    const { endDate: gscEnd } = getLagAwareGscWindow(28);
    const { startDate: gscStart7 } = getLagAwareGscWindow(7);
    const { startDate: gscStart28 } = getLagAwareGscWindow(28);
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

    // Today's news monitor alert — read before synthesis so it can be stored alongside
    const newsAlert = await loadTodaysNewsAlert().catch(() => null);

    // Combined Matomo + GSC synthesis — 28-day picture
    let synthItemsCreated = 0;
    try {
      const reflectionDate = new Date().toISOString().slice(0, 10);
      const useSynthesisBatch = process.env.ALTUS_SYNTHESIS_BATCH_MODE !== 'direct';
      const combined = await getCombinedAnalytics({
        startDate: gscStart28,
        endDate: gscEnd,
        synthesize: true,
        batchMode: useSynthesisBatch,
        newsAlert,
        reflectionDate,
      });

      // Attach news monitor data to the combined object before writing
      const combinedWithNews = {
        ...combined,
        news_monitor: newsAlert
          ? {
              watch_list_matches: newsAlert.watch_list_matches ?? [],
              match_count: newsAlert.watch_list_matches?.length ?? 0,
              news_queries_total: newsAlert.news_queries?.length ?? 0,
            }
          : null,
      };
      if (combined.synthesis) {
        await writeAgentMemory('hal', 'hal:altwire:combined_synthesis', JSON.stringify(combinedWithNews));
        await recordSynthesisFeatures(combined.synthesis, reflectionDate);

        // Proposer: turn synthesis content gaps + SEO opportunities into action items
        synthItemsCreated = await proposeEditorialActionItems(combined.synthesis, reflectionDate);
        if (synthItemsCreated > 0) {
          logger.info('altus-reflection: proposer created action items', { count: synthItemsCreated });
        }
      } else if (combined.synthesis_batch_id) {
        logger.info('altus-reflection: synthesis batch submitted', { batch_id: combined.synthesis_batch_id });
      }
    } catch (err) {
      logger.warn('altus-reflection: combined synthesis failed', { error: err.message });
    }

    // If news alert has watch list matches, create action items for them too
    if (newsAlert?.watch_list_matches?.length > 0) {
      const reflectionDate = new Date().toISOString().slice(0, 10);
      for (const match of newsAlert.watch_list_matches.slice(0, 5)) {
        const title = `News coverage opportunity: ${match.matched_items?.join(', ')} — "${match.query}"`;
        try {
          const existing = await pool.query(
            `SELECT id FROM altus_action_items WHERE title = $1 AND reflection_date = $2 LIMIT 1`,
            [title, reflectionDate],
          );
          if (existing.rows.length > 0) continue;
          await pool.query(
            `INSERT INTO altus_action_items (title, description, category, signal_source, reflection_date)
             VALUES ($1, $2, 'editorial', 'reflection:news_monitor', $3)`,
            [
              title,
              `Google News shows searches for "${match.query}" (${match.impressions ?? '?'} impressions, ${match.clicks ?? '?'} clicks). Watch list match: ${match.matched_items?.join(', ')}.`,
              reflectionDate,
            ],
          );
        } catch (err) {
          logger.warn('altus-reflection: failed to create news match action item', { error: err.message });
        }
      }
    }

    logger.info('altus-reflection: completed', {
      news_matches: newsAlert?.watch_list_matches?.length ?? 0,
      action_items_proposed: synthItemsCreated,
    });
  } catch (err) {
    logger.error('altus-reflection: error', { error: err.message });
    throw err;
  }
}
