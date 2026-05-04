/**
 * Topic Discovery handler — cross-references GSC opportunity-zone queries
 * against AltWire archive coverage to surface story opportunities.
 */

import pool from '../lib/altus-db.js';
import { logger } from '../logger.js';
import { getOpportunityZoneQueries } from './altwire-gsc-client.js';
import { searchAltwireArchive } from './altus-search.js';
import { synthesizePitches } from '../lib/synthesizer.js';
import { logAiUsage } from '../lib/ai-cost-tracker.js';
import { loadEditorialContext, loadTopicTrends, scoreEditorialAffinity } from '../lib/editorial-helpers.js';

const TOPIC_TRENDS_KEY = 'hal:altwire:analytics:topic_trends';
const SEASONALITY_KEY = 'hal:altwire:analytics:seasonality';

async function readAgentMemoryDirect(agent, key) {
  const { rows } = await pool.query(
    'SELECT value FROM agent_memory WHERE agent = $1 AND key = $2',
    [agent, key]
  );
  return rows[0]?.value ?? null;
}

/**
 * Classify coverage gap based on archive weighted_score.
 * @param {number} weightedScore — top result weighted_score from archive search
 * @returns {{ status: string, multiplier: number }}
 */
export function classifyCoverageGap(weightedScore) {
  if (weightedScore < 0.25) return { status: 'no_coverage', multiplier: 1.5 };
  if (weightedScore < 0.50) return { status: 'weak_coverage', multiplier: 1.2 };
  return { status: 'covered', multiplier: 1.0 };
}

/**
 * Score a single opportunity.
 * @param {number} impressions
 * @param {number} position — GSC average position (5–30)
 * @param {number} gapMultiplier — 1.0, 1.2, or 1.5
 * @returns {number}
 */
export function scoreOpportunity(impressions, position, gapMultiplier) {
  const positionProximity = 1 - (position - 5) / 25;
  return impressions * positionProximity * gapMultiplier;
}

/**
 * Fetch story opportunities by cross-referencing GSC demand against archive coverage.
 * @param {{ days?: number }} params — lookback window (default 28)
 * @returns {Promise<object>}
 */
export async function getStoryOpportunities({ days = 28 } = {}) {
  if (process.env.TEST_MODE === 'true') {
    return {
      success: true,
      test_mode: true,
      opportunities: [
        { query: 'test query', impressions: 500, position: 12.3, score: 450, coverageStatus: 'no_coverage', editorialMultiplier: 1.0, pitches: 'Test pitch' },
      ],
      pitches: 'Test editorial pitches',
      cached: false,
    };
  }

  if (!process.env.DATABASE_URL) {
    return { error: 'Database not configured' };
  }

  const editorialContext = await loadEditorialContext(readAgentMemoryDirect);
  const topicTrends = await loadTopicTrends(readAgentMemoryDirect);

  let seasonalityCtx = null;
  try {
    const ssRaw = await readAgentMemoryDirect('hal', SEASONALITY_KEY);
    if (ssRaw) seasonalityCtx = JSON.parse(ssRaw);
  } catch { /* ignore */ }

  const today = new Date().toISOString().slice(0, 10);
  const cacheKey = `altus:story_opportunities:${today}`;

  try {
    const cached = await pool.query(
      'SELECT value FROM agent_memory WHERE agent = $1 AND key = $2',
      ['altus', cacheKey]
    );
    if (cached.rows.length > 0) {
      logger.info('Topic discovery: returning cached result', { cacheKey });
      return { ...JSON.parse(cached.rows[0].value), cached: true };
    }
  } catch (err) {
    logger.warn('Topic discovery: cache read failed, continuing', { error: err.message });
  }

  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(endDate.getDate() - days);
  const startStr = startDate.toISOString().slice(0, 10);
  const endStr = endDate.toISOString().slice(0, 10);

  const gscResult = await getOpportunityZoneQueries(startStr, endStr);
  if (gscResult.error) return gscResult;
  if (gscResult.rows.length === 0) {
    return {
      opportunities: [],
      note: `No queries found in the opportunity zone (position 5-30) for the last ${days} days`,
    };
  }

  const scored = [];
  for (const row of gscResult.rows) {
    const query = row.keys[0];
    const archiveResult = await searchAltwireArchive({ query, limit: 3, content_type: 'all' });
    const topScore = archiveResult?.results?.[0]?.weighted_score ?? 0;
    const gap = classifyCoverageGap(topScore);

    const { affinity } = scoreEditorialAffinity(query, editorialContext, topicTrends);
    const baseScore = scoreOpportunity(row.impressions, row.position, gap.multiplier);
    const editorialMultiplier = affinity > 0 ? affinity : 0;

    // Seasonality bonus: boost topics that peak in the current month
    let seasonalityBonus = 1.0;
    if (seasonalityCtx?.monthly_pattern?.avg_pageviews_by_month) {
      const currentMonth = String(new Date().getMonth() + 1).padStart(2, '0');
      const monthAvg = seasonalityCtx.monthly_pattern.avg_pageviews_by_month[currentMonth] ?? 0;
      const overallAvg = Object.values(seasonalityCtx.monthly_pattern.avg_pageviews_by_month)
        .reduce((s, v) => s + v, 0) / 12;
      if (monthAvg > overallAvg * 1.2) {
        seasonalityBonus = 1.15; // currently in peak season
      } else if (monthAvg < overallAvg * 0.8) {
        seasonalityBonus = 0.85; // currently in low season
      }
    }

    const finalScore = baseScore * editorialMultiplier * seasonalityBonus;

    scored.push({
      query,
      page: row.keys[1] ?? null,
      impressions: row.impressions,
      clicks: row.clicks,
      position: row.position,
      coverageStatus: gap.status,
      gapMultiplier: gap.multiplier,
      score: finalScore,
      editorialMultiplier,
      seasonalityBonus,
    });
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored.filter(o => o.score > 0).slice(0, 10);

  let pitches = '';
  try {
    const synthesis = await synthesizePitches(top);
    pitches = synthesis.pitches;
    await logAiUsage('get_story_opportunities', synthesis.model, synthesis.usage);
  } catch (err) {
    logger.warn('Topic discovery: Haiku synthesis failed, returning without pitches', { error: err.message });
  }

  const result = {
    opportunities: top,
    pitches,
    total_evaluated: gscResult.rows.length,
    date_range: { start: startStr, end: endStr },
    cached: false,
  };

  try {
    await pool.query(
      `INSERT INTO agent_memory (agent, key, value) VALUES ($1, $2, $3)
       ON CONFLICT (agent, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      ['altus', cacheKey, JSON.stringify(result)]
    );
  } catch (err) {
    logger.warn('Topic discovery: cache write failed', { error: err.message });
  }

  return result;
}
