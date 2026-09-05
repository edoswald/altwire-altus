/**
 * altus-mountaineering.js — Supervised hill-climbing optimization loop for Altus.
 * Ported from cirrusly-nimbus/hal-mountaineering.js. Uses altus_ table prefixes.
 */

import Anthropic from '@anthropic-ai/sdk';
import pool from '../lib/altus-db.js';
import { logger } from '../logger.js';
import { logAiUsage } from '../lib/ai-cost-tracker.js';
import { withCachedSystem } from '../lib/anthropic-cache.js';
import { extractText, isRefusal, submitBatch, collectBatch, logBatchUsage } from '../batch-client.js';

export const CLIMB_SLUG_REGEX = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
const SCORING_MODEL = process.env.ANTHROPIC_CLIMB_SCORING_MODEL || 'claude-opus-4-8';
const SCORING_FALLBACK_MODEL = 'claude-sonnet-4-6';

// ---------------------------------------------------------------------------
// Schema init
// ---------------------------------------------------------------------------

export async function initMountaineeringSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS altus_climbs (
      id                    SERIAL          PRIMARY KEY,
      name                  VARCHAR(100)    NOT NULL UNIQUE
                            CHECK (name ~ '^[a-z0-9][a-z0-9-]*[a-z0-9]$'),
      objective             TEXT            NOT NULL,
      metric_description    TEXT            NOT NULL,
      workspace_key         VARCHAR(255)    NOT NULL,
      eval_snapshot         JSONB           NOT NULL,
      status                VARCHAR(20)     NOT NULL DEFAULT 'idle'
                            CHECK (status IN ('idle', 'running', 'paused', 'peaked', 'abandoned')),
      current_score         NUMERIC,
      best_score            NUMERIC,
      best_workspace_value  TEXT,
      iterations            INTEGER         NOT NULL DEFAULT 0,
      created_at            TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
      updated_at            TIMESTAMPTZ     NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`ALTER TABLE altus_climbs ADD COLUMN IF NOT EXISTS current_score NUMERIC`);
  await pool.query(`ALTER TABLE altus_climbs ADD COLUMN IF NOT EXISTS best_score NUMERIC`);
  await pool.query(`ALTER TABLE altus_climbs ADD COLUMN IF NOT EXISTS best_workspace_value TEXT`);
  await pool.query(`ALTER TABLE altus_climbs ADD COLUMN IF NOT EXISTS iterations INTEGER NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE altus_climbs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);

  await pool.query(`CREATE INDEX IF NOT EXISTS altus_climbs_name_idx ON altus_climbs (name)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS altus_climbs_status_idx ON altus_climbs (status)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS altus_climb_iterations (
      id                        SERIAL          PRIMARY KEY,
      climb_id                  INTEGER         NOT NULL REFERENCES altus_climbs(id),
      iteration_number          INTEGER         NOT NULL,
      proposed_change           TEXT            NOT NULL,
      previous_workspace_value  TEXT            NOT NULL,
      score                     NUMERIC,
      batch_id                  VARCHAR(100),
      decision                  VARCHAR(20)
                                CHECK (decision IN ('keep', 'revert', 'plateau')),
      evidence_summary          TEXT,
      created_at                TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
      scored_at                 TIMESTAMPTZ,
      decided_at                TIMESTAMPTZ,
      UNIQUE (climb_id, iteration_number)
    )
  `);

  await pool.query(`ALTER TABLE altus_climb_iterations ADD COLUMN IF NOT EXISTS evidence_summary TEXT`);
  await pool.query(`ALTER TABLE altus_climb_iterations ADD COLUMN IF NOT EXISTS scored_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE altus_climb_iterations ADD COLUMN IF NOT EXISTS decided_at TIMESTAMPTZ`);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS altus_climb_iterations_climb_iter_idx
      ON altus_climb_iterations (climb_id, iteration_number)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS altus_climb_iterations_batch_idx
      ON altus_climb_iterations (batch_id)
      WHERE batch_id IS NOT NULL
  `);

  logger.info('altus-mountaineering: schema ready');

  await seedMountaineeringClimbs();
}

// ---------------------------------------------------------------------------
// Seed workspace values and climbs
// ---------------------------------------------------------------------------

const DIGEST_FORMAT_SEED = {
  version: '1.0',
  description: "Morning digest format template. Workspace for the morning-digest-v1 mountaineering climb. Hal proposes structural changes to maximize Derek's daily engagement with the digest.",
  section_order: ['revenue_traffic', 'search_performance', 'content_opportunities', 'review_pipeline', 'action_items'],
  section_guidance: {
    revenue_traffic: 'Opening: the single most notable traffic or engagement signal from the past 24h. One sentence with a concrete number.',
    search_performance: 'Top GSC opportunity — one query with high impressions and low CTR. Include query text, impressions, and current position.',
    content_opportunities: "One story opportunity from Derek's watch list or breaking news from the news monitor. Include why it's timely.",
    review_pipeline: 'Review deadline alerts and loaner status — only include if there is an action due within 48h.',
    action_items: 'Up to 3 items Derek should act on today, ranked by urgency. Lead with the action verb.',
  },
  tone_guidance: 'Direct and editorial. Lead with data, follow with interpretation. No filler.',
  length_target: '300-500 words total',
};

const DIGEST_FORMAT_EVAL = {
  scoring_criteria: [
    { criterion: 'actionability', weight: 0.40, description: "Does the proposed format surface the highest-urgency item prominently and early so Derek can act within 2 minutes of reading?" },
    { criterion: 'signal_clarity', weight: 0.35, description: 'Does the format make key data signals (traffic, GSC position, CTR) immediately readable without prose hunting? Score higher when data leads and prose explains.' },
    { criterion: 'concision', weight: 0.25, description: 'Does the format enforce brevity? Score lower if sections allow vague qualitative text instead of specific numbers and named subjects.' },
  ],
  scoring_note: 'Score each criterion 0.0-1.0. Final score = weighted sum. Evaluate the FORMAT (structure, guidance) — not hypothetical content. A score above 0.75 represents a meaningfully better format than the baseline.',
};

const HEADLINE_GUIDELINES_SEED = {
  version: '1.0',
  description: 'Article headline writing guidelines. Workspace for the headline-v1 mountaineering climb. Hal proposes guideline changes to improve average CTR for AltWire articles.',
  max_length: 70,
  preferred_length: '50-65 characters',
  keyword_placement: 'Primary keyword in first 4 words when possible',
  patterns: {
    review: "Include product name and year. Example: \"Sony A7C II Review: The Travel Photographer's Answer\"",
    comparison: 'Name both subjects. Example: "Sony A7C II vs Fujifilm X-T5: Which Wins for Street Photography?"',
    news: 'Lead with the most significant fact. Avoid vague teasers.',
    guide: 'Front-load the use case. Example: "How to Shoot Film with Your Mirrorless Camera"',
  },
  avoid: ["superlatives without supporting data", "vague questions as headlines", "year-only clickbait ('The Best Cameras of 2025')"],
  brand_note: "Do not include 'AltWire' in headlines — the site name appears in browser title and SERPs separately.",
};

const HEADLINE_EVAL = {
  scoring_criteria: [
    { criterion: 'query_intent_alignment', weight: 0.40, description: "Does the proposed guideline change help headlines match the intent of AltWire's best-performing GSC queries (review, comparison, how-to)? Score higher if the change surfaces clearer signals for informational vs. transactional intent." },
    { criterion: 'seo_best_practices', weight: 0.35, description: 'Does the guideline follow headline SEO best practices: primary keyword early, 50-65 characters preferred, no stuffing? Score lower if the guideline loosens these constraints without good reason.' },
    { criterion: 'editorial_voice', weight: 0.25, description: "Does the guideline preserve AltWire's direct, technically-informed editorial voice? Score lower if the change pushes toward generic or listicle patterns." },
  ],
  reference_queries: [
    'Top AltWire GSC queries: mirrorless camera review, best travel camera, sony a7 vs fujifilm',
  ],
  scoring_note: 'Score each criterion 0.0-1.0. Final score = weighted sum. Evaluate the GUIDELINE CHANGE being proposed — not a specific headline. A score above 0.75 is meaningfully better than baseline.',
};

export async function seedMountaineeringClimbs() {
  if (!process.env.ALTWIRE_DATABASE_URL && !process.env.DATABASE_URL) return;

  // Step 1: hal:altwire:digest_format workspace key
  const digestKeyExists = await pool.query(
    `SELECT key FROM agent_memory WHERE agent = 'hal' AND key = 'hal:altwire:digest_format'`
  );
  if (digestKeyExists.rows.length === 0) {
    await pool.query(
      `INSERT INTO agent_memory (agent, key, value) VALUES ('hal', 'hal:altwire:digest_format', $1) ON CONFLICT (agent, key) DO NOTHING`,
      [JSON.stringify(DIGEST_FORMAT_SEED)]
    );
    logger.info('[seed] Created workspace key: hal:altwire:digest_format');
  } else {
    logger.info('[seed] Skipped (exists): hal:altwire:digest_format');
  }

  // Step 2: hal:altwire:headline_guidelines workspace key
  const headlineKeyExists = await pool.query(
    `SELECT key FROM agent_memory WHERE agent = 'hal' AND key = 'hal:altwire:headline_guidelines'`
  );
  if (headlineKeyExists.rows.length === 0) {
    await pool.query(
      `INSERT INTO agent_memory (agent, key, value) VALUES ('hal', 'hal:altwire:headline_guidelines', $1) ON CONFLICT (agent, key) DO NOTHING`,
      [JSON.stringify(HEADLINE_GUIDELINES_SEED)]
    );
    logger.info('[seed] Created workspace key: hal:altwire:headline_guidelines');
  } else {
    logger.info('[seed] Skipped (exists): hal:altwire:headline_guidelines');
  }

  // Step 3: morning-digest-v1 climb
  const digestClimbExists = await pool.query(`SELECT id FROM altus_climbs WHERE name = 'morning-digest-v1'`);
  if (digestClimbExists.rows.length === 0) {
    const keyCheck = await pool.query(
      `SELECT key FROM agent_memory WHERE agent = 'hal' AND key = 'hal:altwire:digest_format'`
    );
    if (keyCheck.rows.length > 0) {
      const result = await createClimb({
        name: 'morning-digest-v1',
        objective: "Optimize the AltWire morning digest format to maximize Derek's engagement — actions taken, follow-up tool calls, and response within 2 hours",
        metric_description: 'Weighted score across actionability (40%), signal clarity (35%), and concision (25%). Evaluated by Claude Haiku against the proposed format structure.',
        workspace_key: 'hal:altwire:digest_format',
        eval_snapshot: DIGEST_FORMAT_EVAL,
      });
      if (result.success) {
        logger.info('[seed] Created climb: morning-digest-v1');
      } else {
        logger.error('[seed] Failed to create climb: morning-digest-v1', { reason: result.exit_reason });
      }
    }
  } else {
    logger.info('[seed] Skipped (exists): morning-digest-v1');
  }

  // Step 4: headline-v1 climb
  const headlineClimbExists = await pool.query(`SELECT id FROM altus_climbs WHERE name = 'headline-v1'`);
  if (headlineClimbExists.rows.length === 0) {
    const keyCheck = await pool.query(
      `SELECT key FROM agent_memory WHERE agent = 'hal' AND key = 'hal:altwire:headline_guidelines'`
    );
    if (keyCheck.rows.length > 0) {
      const result = await createClimb({
        name: 'headline-v1',
        objective: 'Optimize article headline writing guidelines to improve average GSC click-through rate for AltWire articles',
        metric_description: 'Weighted score across query intent alignment (40%), SEO best practices (35%), and editorial voice preservation (25%). Evaluated by Claude Haiku per-guideline-change.',
        workspace_key: 'hal:altwire:headline_guidelines',
        eval_snapshot: HEADLINE_EVAL,
      });
      if (result.success) {
        logger.info('[seed] Created climb: headline-v1');
      } else {
        logger.error('[seed] Failed to create climb: headline-v1', { reason: result.exit_reason });
      }
    }
  } else {
    logger.info('[seed] Skipped (exists): headline-v1');
  }
}

// ---------------------------------------------------------------------------
// createClimb
// ---------------------------------------------------------------------------

export async function createClimb({ name, objective, metric_description, workspace_key, eval_snapshot }) {
  if (!process.env.ALTWIRE_DATABASE_URL && !process.env.DATABASE_URL) {
    return { success: false, exit_reason: 'config_error' };
  }

  if (process.env.TEST_MODE === 'true') {
    return { success: true, test_mode: true, climb_id: 0, name, status: 'idle' };
  }

  if (!CLIMB_SLUG_REGEX.test(name)) {
    return { success: false, exit_reason: 'validation_error', message: 'name must be lowercase alphanumeric with hyphens' };
  }

  if (!eval_snapshot || typeof eval_snapshot !== 'object' || Array.isArray(eval_snapshot) || Object.keys(eval_snapshot).length === 0) {
    return { success: false, exit_reason: 'validation_error', message: 'eval_snapshot must be a non-empty JSON object' };
  }

  const memCheck = await pool.query(`SELECT key FROM agent_memory WHERE key = $1`, [workspace_key]);
  if (memCheck.rows.length === 0) {
    return { success: false, exit_reason: 'validation_error', message: `workspace_key '${workspace_key}' not found in agent_memory` };
  }

  try {
    const result = await pool.query(
      `INSERT INTO altus_climbs (name, objective, metric_description, workspace_key, eval_snapshot, status, iterations)
       VALUES ($1, $2, $3, $4, $5, 'idle', 0)
       RETURNING id`,
      [name, objective, metric_description, workspace_key, JSON.stringify(eval_snapshot)]
    );
    const climb_id = result.rows[0].id;
    logger.info(`altus-mountaineering: created climb '${name}' (id=${climb_id})`);
    return { success: true, climb_id, name, status: 'idle' };
  } catch (err) {
    if (err.code === '23505') {
      return { success: false, exit_reason: 'conflict', message: `A climb named '${name}' already exists.` };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// startClimbIteration
// ---------------------------------------------------------------------------

async function _startClimbIterationCore(climb_name) {
  if (!process.env.ALTWIRE_DATABASE_URL && !process.env.DATABASE_URL) {
    return { success: false, exit_reason: 'config_error' };
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return { success: false, exit_reason: 'config_error', message: 'ANTHROPIC_API_KEY not configured.' };
  }

  const climbResult = await pool.query(
    `SELECT id, name, objective, metric_description, workspace_key, eval_snapshot, status, iterations
     FROM altus_climbs WHERE name = $1`,
    [climb_name]
  );
  if (climbResult.rows.length === 0) {
    return { success: false, exit_reason: 'not_found', message: `Climb '${climb_name}' not found.` };
  }
  const climb = climbResult.rows[0];

  if (climb.status !== 'idle' && climb.status !== 'running') {
    return { success: false, exit_reason: 'invalid_status', message: `Climb '${climb_name}' is ${climb.status} — cannot start a new iteration.` };
  }

  const memResult = await pool.query(`SELECT value FROM agent_memory WHERE key = $1`, [climb.workspace_key]);
  if (memResult.rows.length === 0) {
    return { success: false, exit_reason: 'workspace_error', message: `workspace_key '${climb.workspace_key}' not found in agent_memory` };
  }
  const previous_workspace_value = memResult.rows[0].value;

  const historyResult = await pool.query(
    `SELECT iteration_number, proposed_change, score, decision
     FROM altus_climb_iterations
     WHERE climb_id = $1 AND decision IS NOT NULL
     ORDER BY iteration_number DESC LIMIT 5`,
    [climb.id]
  );
  const lastDecisions = historyResult.rows.length > 0 ? JSON.stringify(historyResult.rows) : 'No previous iterations';

  const systemPrompt = `You are proposing a targeted change to improve Hal's ${climb.objective}.\nRespond with JSON only: { "proposed_change": "...", "rationale": "..." }\nproposed_change is the complete new value to write to the workspace — not a diff.`;
  const userPrompt = `Metric: ${climb.metric_description}\n\nCurrent workspace value:\n${previous_workspace_value}\n\nEval criteria:\n${JSON.stringify(climb.eval_snapshot)}\n\nLast 5 iteration decisions:\n${lastDecisions}\n\nPropose a targeted change that improves the metric.`;

  let proposed_change, rationale, response;
  try {
    const anthropic = new Anthropic();
    response = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 4096,
      // Stable for the climb lifecycle — the same system prompt is sent for
      // every proposal iteration, so cache it after the first write.
      system: withCachedSystem(systemPrompt),
      messages: [{ role: 'user', content: userPrompt }],
    });
    const parsed = JSON.parse(response.content[0].text);
    proposed_change = parsed.proposed_change;
    rationale = parsed.rationale;
  } catch (err) {
    return { success: false, exit_reason: 'proposal_error', message: err.message };
  }

  if (typeof proposed_change !== 'string' || proposed_change.trim() === '') {
    return { success: false, exit_reason: 'proposal_error', message: 'Response JSON missing or empty proposed_change field' };
  }

  logAiUsage('mountaineering_proposal', 'claude-haiku-4-5', response.usage);

  const iteration_number = climb.iterations + 1;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE agent_memory SET value = $1 WHERE key = $2`, [proposed_change, climb.workspace_key]);
    await client.query(
      `INSERT INTO altus_climb_iterations (climb_id, iteration_number, proposed_change, previous_workspace_value)
       VALUES ($1, $2, $3, $4)`,
      [climb.id, iteration_number, proposed_change, previous_workspace_value]
    );
    await client.query(
      `UPDATE altus_climbs SET iterations = iterations + 1, status = 'running', updated_at = NOW() WHERE id = $1`,
      [climb.id]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    return { success: false, exit_reason: 'proposal_error', message: err.message };
  } finally {
    client.release();
  }

  logger.info(`altus-mountaineering: iteration ${iteration_number} started for climb '${climb_name}'`);
  return { success: true, climb_name, iteration_number, proposed_change, rationale, previous_workspace_value };
}

export async function startClimbIteration({ climb_name }) {
  if (process.env.TEST_MODE === 'true') {
    return { success: true, test_mode: true, climb_name, iteration_number: 1, proposed_change: 'mock', rationale: 'test mode', previous_workspace_value: 'mock' };
  }
  return _startClimbIterationCore(climb_name);
}

async function buildScoringPrompt({ evalSnapshot, proposedChange, createdAt }) {
  let evidenceJson = 'No evidence available';
  try {
    const evResult = await pool.query(
      `SELECT event_type, tool_name, payload, error_message, duration_ms, created_at FROM altus_events
       WHERE created_at >= $1 ORDER BY created_at DESC LIMIT 50`,
      [createdAt]
    );
    if (evResult.rows.length > 0) evidenceJson = JSON.stringify(evResult.rows);
  } catch (_) {}

  return {
    system: `You are evaluating a workspace change for Hal's optimization loop.\nScore the change 0.0-1.0 based on the eval criteria.\nRespond with JSON only: { "score": 0.0, "evidence_summary": "..." }`,
    user: `Eval criteria:\n${JSON.stringify(evalSnapshot)}\n\nProposed change applied:\n${proposedChange}\n\nEvidence from altus_events since iteration applied:\n${evidenceJson}\n\nScore this change.`,
  };
}

function parseScoringText(text) {
  if (!text) return null;
  const parsed = JSON.parse(text);
  const rawScore = parseFloat(parsed.score);
  if (Number.isNaN(rawScore) || rawScore < 0.0 || rawScore > 1.0) return null;
  return { score: rawScore, evidenceSummary: parsed.evidence_summary || null };
}

async function scoreClimbFallback(iter) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not configured');
  const prompt = await buildScoringPrompt({
    evalSnapshot: iter.eval_snapshot,
    proposedChange: iter.proposed_change,
    createdAt: iter.created_at,
  });
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await anthropic.messages.create({
    model: SCORING_FALLBACK_MODEL,
    max_tokens: 1024,
    // buildScoringPrompt's system text is identical for every fallback scoring
    // call — cache it so repeat scores skip the full write cost.
    system: withCachedSystem(prompt.system),
    messages: [{ role: 'user', content: prompt.user }],
  });
  await logAiUsage('altus_score_climb_fallback', response.model ?? SCORING_FALLBACK_MODEL, response.usage);
  const text = response.content?.find((block) => block.type === 'text')?.text;
  return parseScoringText(text);
}

// ---------------------------------------------------------------------------
// scoreClimbIteration
// ---------------------------------------------------------------------------

export async function scoreClimbIteration({ climb_name, iteration_number }) {
  if (!process.env.ALTWIRE_DATABASE_URL && !process.env.DATABASE_URL) {
    return { success: false, exit_reason: 'config_error' };
  }
  if (process.env.TEST_MODE === 'true') {
    return { success: true, test_mode: true, climb_name, iteration_number, batch_id: 'mock-batch-id', message: 'Scoring queued.' };
  }

  const climbResult = await pool.query(
    `SELECT id, name, eval_snapshot, metric_description FROM altus_climbs WHERE name = $1`,
    [climb_name]
  );
  if (climbResult.rows.length === 0) {
    return { success: false, exit_reason: 'not_found', message: `Climb '${climb_name}' not found.` };
  }
  const climb = climbResult.rows[0];

  const iterResult = await pool.query(
    `SELECT id, proposed_change, score, created_at FROM altus_climb_iterations
     WHERE climb_id = $1 AND iteration_number = $2`,
    [climb.id, iteration_number]
  );
  if (iterResult.rows.length === 0) {
    return { success: false, exit_reason: 'not_found', message: `Iteration ${iteration_number} of climb '${climb_name}' not found.` };
  }
  const iteration = iterResult.rows[0];
  if (iteration.score !== null) {
    return { success: false, exit_reason: 'already_scored', message: `Iteration ${iteration_number} has already been scored.` };
  }

  const scoringPrompt = await buildScoringPrompt({
    evalSnapshot: climb.eval_snapshot,
    proposedChange: iteration.proposed_change,
    createdAt: iteration.created_at,
  });

  const batchRequest = [{
    custom_id: String(iteration.id),
    params: {
      model: SCORING_MODEL,
      max_tokens: 2048,
      output_config: { effort: 'high' },
      // The scoring system text is identical across iterations — cached so
      // batch scoring is billed at the cache-read rate after the first write.
      system: withCachedSystem(scoringPrompt.system),
      messages: [{ role: 'user', content: scoringPrompt.user }],
    },
  }];

  let batch_id;
  try {
    batch_id = await submitBatch(batchRequest);
  } catch (err) {
    return { success: false, exit_reason: 'batch_error', message: err.message };
  }

  await pool.query(`UPDATE altus_climb_iterations SET batch_id = $1 WHERE id = $2`, [batch_id, iteration.id]);
  logger.info(`altus-mountaineering: scoring queued for climb '${climb_name}' iteration ${iteration_number} (batch_id=${batch_id})`);

  return { success: true, climb_name, iteration_number, batch_id, message: 'Scoring queued — results collected by mountaineering batch cron.' };
}

// ---------------------------------------------------------------------------
// collectClimbScores (called by cron)
// ---------------------------------------------------------------------------

export async function collectClimbScores() {
  if (!process.env.ALTWIRE_DATABASE_URL && !process.env.DATABASE_URL) return;

  const pendingResult = await pool.query(
    `SELECT DISTINCT batch_id FROM altus_climb_iterations WHERE batch_id IS NOT NULL AND score IS NULL`
  );
  if (pendingResult.rows.length === 0) return;

  for (const { batch_id } of pendingResult.rows) {
    let results;
    try {
      results = await collectBatch(batch_id);
    } catch (err) {
      logger.error(`altus-mountaineering: collectBatch failed for batch_id=${batch_id}`, { error: err.message });
      continue;
    }
    if (results === null) continue;

    for (const item of results) {
      const iterRow = await pool.query(
        `SELECT i.id, i.climb_id, i.iteration_number, i.proposed_change, i.created_at,
                c.workspace_key, c.best_score, c.eval_snapshot
         FROM altus_climb_iterations i
         JOIN altus_climbs c ON c.id = i.climb_id
         WHERE i.id = $1 AND i.score IS NULL`,
        [parseInt(item.custom_id, 10)]
      );
      if (iterRow.rows.length === 0) continue;
      const iter = iterRow.rows[0];

      let score = null, evidenceSummary = null;
      try {
        if (item.result?.type === 'succeeded' && !isRefusal(item)) {
          const parsedScore = parseScoringText(extractText(item));
          if (parsedScore) {
            score = parsedScore.score;
            evidenceSummary = parsedScore.evidenceSummary;
          }
        }
      } catch (parseErr) {
        logger.error(`altus-mountaineering: parse error for iteration id=${item.custom_id}`, { error: parseErr.message });
      }

      if (score === null && item.result?.type === 'succeeded') {
        try {
          const fallbackScore = await scoreClimbFallback(iter);
          if (fallbackScore) {
            score = fallbackScore.score;
            evidenceSummary = fallbackScore.evidenceSummary;
          }
        } catch (fallbackErr) {
          logger.error(`altus-mountaineering: fallback scoring failed for iteration id=${item.custom_id}`, { error: fallbackErr.message });
        }
      }

      if (score === null && item.result?.type === 'succeeded') {
        const reason = isRefusal(item) ? 'refusal' : 'unparseable_response';
        await pool.query(
          `UPDATE altus_climb_iterations
              SET evidence_summary = $1, batch_id = NULL
            WHERE id = $2`,
          [`scoring_failed: ${reason}`, iter.id],
        );
        logger.error(`altus-mountaineering: scoring failed terminally for iteration id=${item.custom_id}`, { reason });
      }

      if (score !== null) {
        await pool.query(
          `UPDATE altus_climb_iterations SET score = $1, evidence_summary = $2, scored_at = NOW() WHERE id = $3`,
          [score, evidenceSummary, iter.id]
        );
        await pool.query(
          `UPDATE altus_climbs SET current_score = $1, updated_at = NOW() WHERE id = $2`,
          [score, iter.climb_id]
        );
        if (iter.best_score === null || score > parseFloat(iter.best_score)) {
          await pool.query(
            `UPDATE altus_climbs SET best_score = $1, best_workspace_value = $2, updated_at = NOW() WHERE id = $3`,
            [score, iter.proposed_change, iter.climb_id]
          );
        }
        logger.info(`altus-mountaineering: scored iteration ${iter.iteration_number} of climb_id=${iter.climb_id} — score=${score}`);
      }
    }

    try {
      await logBatchUsage(batch_id, results, 'altus_score_climb_iteration');
    } catch (err) {
      logger.error(`altus-mountaineering: logBatchUsage failed for batch_id=${batch_id}`, { error: err.message });
    }
  }
}

// ---------------------------------------------------------------------------
// getClimbStatus
// ---------------------------------------------------------------------------

const PLATEAU_SUGGESTIONS = [
  'Consider injecting new domain knowledge via the objective field.',
  'Consider abandoning this climb and starting a new one with a different approach.',
  'Consider pausing the climb and reviewing the eval_snapshot for relevance.',
];

export async function getClimbStatus({ climb_name }) {
  if (!process.env.ALTWIRE_DATABASE_URL && !process.env.DATABASE_URL) {
    return { success: false, exit_reason: 'config_error' };
  }

  const climbResult = await pool.query(
    `SELECT id, name, objective, status, current_score, best_score, iterations, workspace_key
     FROM altus_climbs WHERE name = $1`,
    [climb_name]
  );
  if (climbResult.rows.length === 0) {
    return { success: false, exit_reason: 'not_found', message: `Climb '${climb_name}' not found.` };
  }
  const climb = climbResult.rows[0];

  const scoredResult = await pool.query(
    `SELECT score FROM altus_climb_iterations WHERE climb_id = $1 AND score IS NOT NULL ORDER BY iteration_number DESC LIMIT 2`,
    [climb.id]
  );
  let trend = 'unknown';
  if (scoredResult.rows.length >= 2) {
    const last = parseFloat(scoredResult.rows[0].score);
    const prev = parseFloat(scoredResult.rows[1].score);
    if (last > prev) trend = 'improving';
    else if (last < prev) trend = 'declining';
    else trend = 'flat';
  }

  const recentResult = await pool.query(
    `SELECT iteration_number, score, decision, decided_at
     FROM altus_climb_iterations WHERE climb_id = $1 AND decision IS NOT NULL
     ORDER BY iteration_number DESC LIMIT 5`,
    [climb.id]
  );

  const response = {
    success: true,
    name: climb.name,
    objective: climb.objective,
    status: climb.status,
    current_score: climb.current_score !== null ? parseFloat(climb.current_score) : null,
    best_score: climb.best_score !== null ? parseFloat(climb.best_score) : null,
    iterations: climb.iterations,
    workspace_key: climb.workspace_key,
    recent_decisions: recentResult.rows,
    trend,
  };

  if (climb.status !== 'peaked' && climb.status !== 'abandoned') {
    const allDecidedResult = await pool.query(
      `SELECT decision FROM altus_climb_iterations WHERE climb_id = $1 AND decision IS NOT NULL ORDER BY iteration_number DESC`,
      [climb.id]
    );
    let plateauStreak = 0;
    for (const row of allDecidedResult.rows) {
      if (row.decision === 'plateau') plateauStreak++;
      else break;
    }
    if (plateauStreak >= 3) {
      response.plateau_alert = true;
      response.plateau_streak = plateauStreak;
      response.suggestion = PLATEAU_SUGGESTIONS[(plateauStreak - 3) % PLATEAU_SUGGESTIONS.length];
    }
  }

  return response;
}

// ---------------------------------------------------------------------------
// supervisorDecision
// ---------------------------------------------------------------------------

export async function supervisorDecision({ climb_name, iteration_number, decision }) {
  if (!process.env.ALTWIRE_DATABASE_URL && !process.env.DATABASE_URL) {
    return { success: false, exit_reason: 'config_error' };
  }
  if (process.env.TEST_MODE === 'true') {
    return { success: true, test_mode: true, climb_name, iteration_number, decision, workspace_restored: false };
  }

  const climbResult = await pool.query(`SELECT id, workspace_key FROM altus_climbs WHERE name = $1`, [climb_name]);
  if (climbResult.rows.length === 0) {
    return { success: false, exit_reason: 'not_found', message: `Climb '${climb_name}' not found.` };
  }
  const climb = climbResult.rows[0];

  const iterResult = await pool.query(
    `SELECT id, score, decision, previous_workspace_value FROM altus_climb_iterations
     WHERE climb_id = $1 AND iteration_number = $2`,
    [climb.id, iteration_number]
  );
  if (iterResult.rows.length === 0) {
    return { success: false, exit_reason: 'not_found', message: `Iteration ${iteration_number} of climb '${climb_name}' not found.` };
  }
  const iteration = iterResult.rows[0];

  if (iteration.score === null) {
    return { success: false, exit_reason: 'not_scored', message: `Iteration ${iteration_number} has not been scored yet.` };
  }
  if (iteration.decision !== null) {
    return { success: false, exit_reason: 'already_decided', message: `Iteration ${iteration_number} already has a decision.` };
  }

  await pool.query(`UPDATE altus_climb_iterations SET decision = $1, decided_at = NOW() WHERE id = $2`, [decision, iteration.id]);

  let workspace_restored = false;
  if (decision === 'revert' || decision === 'plateau') {
    await pool.query(`UPDATE agent_memory SET value = $1 WHERE key = $2`, [iteration.previous_workspace_value, climb.workspace_key]);
    workspace_restored = true;
  }

  logger.info(`altus-mountaineering: decision '${decision}' applied to climb '${climb_name}' iteration ${iteration_number}`);
  return { success: true, climb_name, iteration_number, decision, workspace_restored };
}

// ---------------------------------------------------------------------------
// peakClimb
// ---------------------------------------------------------------------------

export async function peakClimb({ climb_name }) {
  if (!process.env.ALTWIRE_DATABASE_URL && !process.env.DATABASE_URL) {
    return { success: false, exit_reason: 'config_error' };
  }
  if (process.env.TEST_MODE === 'true') {
    return { success: true, test_mode: true, climb_name, status: 'peaked', best_score: null, best_workspace_value: null, iterations: 0 };
  }

  const climbResult = await pool.query(
    `SELECT id, name, status, best_score, iterations, workspace_key FROM altus_climbs WHERE name = $1`,
    [climb_name]
  );
  if (climbResult.rows.length === 0) {
    return { success: false, exit_reason: 'not_found', message: `Climb '${climb_name}' not found.` };
  }
  const climb = climbResult.rows[0];

  if (climb.status !== 'running' && climb.status !== 'paused') {
    return { success: false, exit_reason: 'invalid_status', message: `Climb '${climb_name}' is ${climb.status} — cannot peak.` };
  }

  let best_workspace_value = climb.best_workspace_value || null;
  try {
    const memResult = await pool.query(`SELECT value FROM agent_memory WHERE key = $1`, [climb.workspace_key]);
    if (memResult.rows.length > 0) best_workspace_value = memResult.rows[0].value;
  } catch (_) {}

  await pool.query(
    `UPDATE altus_climbs SET status = 'peaked', best_workspace_value = $1, updated_at = NOW() WHERE id = $2`,
    [best_workspace_value, climb.id]
  );

  const best_score = climb.best_score !== null ? parseFloat(climb.best_score) : null;
  logger.info(`altus-mountaineering: climb '${climb_name}' peaked (best_score=${best_score})`);
  return { success: true, climb_name, status: 'peaked', best_score, best_workspace_value, iterations: climb.iterations };
}

// ---------------------------------------------------------------------------
// getClimbHistory
// ---------------------------------------------------------------------------

export async function getClimbHistory({ climb_name, limit, offset }) {
  if (!process.env.ALTWIRE_DATABASE_URL && !process.env.DATABASE_URL) {
    return { success: false, exit_reason: 'config_error' };
  }

  const climbResult = await pool.query(
    `SELECT id, name, objective, status, best_score, iterations FROM altus_climbs WHERE name = $1`,
    [climb_name]
  );
  if (climbResult.rows.length === 0) {
    return { success: false, exit_reason: 'not_found', message: `Climb '${climb_name}' not found.` };
  }
  const climb = climbResult.rows[0];

  const clampedLimit = Math.min(Math.max(limit || 50, 1), 200);
  const clampedOffset = Math.max(offset || 0, 0);

  const historyResult = await pool.query(
    `SELECT iteration_number, proposed_change, previous_workspace_value, score, decision,
            evidence_summary, created_at, scored_at, decided_at
     FROM altus_climb_iterations WHERE climb_id = $1
     ORDER BY iteration_number ASC LIMIT $2 OFFSET $3`,
    [climb.id, clampedLimit, clampedOffset]
  );

  return {
    success: true,
    name: climb.name,
    objective: climb.objective,
    status: climb.status,
    best_score: climb.best_score !== null ? parseFloat(climb.best_score) : null,
    iterations: climb.iterations,
    history: historyResult.rows,
  };
}
