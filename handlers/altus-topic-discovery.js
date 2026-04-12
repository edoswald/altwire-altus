/**
 * Topic Discovery handler — cross-references GSC opportunity-zone queries
 * against AltWire archive coverage to surface story opportunities.
 */

import pool from '../lib/altus-db.js';
import { logger } from '../logger.js';
import { getOpportunityZoneQueries } from './altwire-gsc-client.js';
import { searchAltwareArchive } from './altus-search.js';
import { synthesizePitches } from '../lib/synthesizer.js';
import { logAiUsage } from '../lib/ai-cost-tracker.js';

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
        { query: 'test query', impressions: 500, position: 12.3, score: 450, coverageStatus: 'no_coverage', pitches: 'Test pitch' },
      ],
      pitches: 'Test editorial pitches',
      cached: false,
    };
  }

  if (!process.env.DATABASE_URL) {
    return { error: 'Database not configured' };
  }

  // Check cache
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

  // Compute date range
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(endDate.getDate() - days);
  const startStr = startDate.toISOString().slice(0, 10);
  const endStr = endDate.toISOString().slice(0, 10);

  // Fetch opportunity zone queries
  const gscResult = await getOpportunityZoneQueries(startStr, endStr);
  if (gscResult.error) return gscResult;
  if (gscResult.rows.length === 0) {
    return {
      opportunities: [],
      note: `No queries found in the opportunity zone (position 5-30) for the last ${days} days`,
    };
  }

  // Check archive coverage for each query
  const scored = [];
  for (const row of gscResult.rows) {
    const query = row.keys[0];
    const archiveResult = await searchAltwareArchive({ query, limit: 3, content_type: 'all' });
    const topScore = archiveResult?.results?.[0]?.weighted_score ?? 0;
    const gap = classifyCoverageGap(topScore);

    scored.push({
      query,
      page: row.keys[1] ?? null,
      impressions: row.impressions,
      clicks: row.clicks,
      position: row.position,
      coverageStatus: gap.status,
      gapMultiplier: gap.multiplier,
      score: scoreOpportunity(row.impressions, row.position, gap.multiplier),
    });
  }

  // Sort by score descending, take top 10
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 10);

  // Synthesize pitches
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

  // Cache result
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
