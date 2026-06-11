/**
 * ai-cost-tracker.js
 *
 * Tracks Anthropic API usage and estimated cost in PostgreSQL.
 *
 * Rates (hardcoded — update when Anthropic pricing changes).
 */

import pool from "./altus-db.js";
import { logger } from "../logger.js";

// ---------------------------------------------------------------------------
// Pricing table ($ per 1M tokens)
// ---------------------------------------------------------------------------

const PRICING = {
  // Haiku 4.5
  "claude-haiku-4-5-20251001": { input: 1.00,   output: 5.00  },
  "claude-haiku-4-5-20250514": { input: 1.00,   output: 5.00  },
  "claude-haiku-4-5":          { input: 1.00,   output: 5.00  },
  // Sonnet 4.6
  "claude-sonnet-4-6":         { input: 3.00,   output: 15.00 },
  // Fable / Opus
  "claude-fable-5":            { input: 10.00,  output: 50.00 },
  "claude-opus-4-6":           { input: 5.00,   output: 25.00 },
  "claude-opus-4-7":           { input: 5.00,   output: 25.00 },
  // OpenAI (approximate, for completeness)
  "gpt-4o":                    { input: 2.50,   output: 10.00 },
  "gpt-4o-mini":               { input: 0.15,   output: 0.60  },
  "o3":                        { input: 10.00,  output: 40.00 },
  "o1":                        { input: 15.00,  output: 60.00 },
};

function calcCost(model, inputTokens, outputTokens, cacheReadTokens = 0, cacheCreationTokens = 0, { isBatch = false } = {}) {
  // Exact match first, then prefix match.
  let price = PRICING[model];
  if (!price) {
    for (const [key, p] of Object.entries(PRICING)) {
      if (model.startsWith(key) || key.startsWith(model)) { price = p; break; }
    }
  }
  if (!price) return 0; // Unknown model — record tokens but no cost estimate.

  const baseCost = (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
  const cacheCost = (cacheReadTokens * price.input * 0.10 + cacheCreationTokens * price.input * 1.25) / 1_000_000;
  const cost = baseCost + cacheCost;
  return isBatch ? cost * 0.5 : cost;
}

// ---------------------------------------------------------------------------
// Schema init
// ---------------------------------------------------------------------------

export async function initAiUsageSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_usage (
      id                 SERIAL PRIMARY KEY,
      tool_name          VARCHAR(100)  NOT NULL,
      model              VARCHAR(100)  NOT NULL,
      input_tokens       INTEGER       NOT NULL DEFAULT 0,
      output_tokens      INTEGER       NOT NULL DEFAULT 0,
      estimated_cost_usd NUMERIC(12,8) NOT NULL DEFAULT 0,
      created_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS ai_usage_tool_idx ON ai_usage (tool_name)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ai_usage_ts_idx   ON ai_usage (created_at)`);
  await pool.query(`ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS cache_read_tokens INTEGER`);
  await pool.query(`ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS cache_creation_tokens INTEGER`);
  await pool.query(`ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS is_batch BOOLEAN NOT NULL DEFAULT false`);
}

// ---------------------------------------------------------------------------
// Log a single API call
// ---------------------------------------------------------------------------

/**
 * Log one Anthropic API call to the ai_usage table.
 * Non-throwing — errors are logged but never propagated.
 *
 * @param {string} toolName  MCP tool name that triggered the call
 * @param {string} model     Anthropic model ID (e.g. response.model)
 * @param {{ input_tokens: number, output_tokens: number, cache_read_input_tokens?: number, cache_creation_input_tokens?: number }} usage  From response.usage
 * @param {{ isBatch?: boolean }} options
 */
export async function logAiUsage(toolName, model, usage, options = {}) {
  if (!process.env.ALTWIRE_DATABASE_URL && !process.env.DATABASE_URL) return;
  try {
    const inputTokens         = usage?.input_tokens  ?? 0;
    const outputTokens        = usage?.output_tokens ?? 0;
    const cacheReadTokens     = usage?.cache_read_input_tokens ?? 0;
    const cacheCreationTokens = usage?.cache_creation_input_tokens ?? 0;
    const isBatch             = options?.isBatch === true;
    const cost                = calcCost(model, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, { isBatch });
    await pool.query(
      `INSERT INTO ai_usage (tool_name, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, estimated_cost_usd, is_batch)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [toolName, model, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, cost, isBatch],
    );
  } catch (err) {
    logger.error("logAiUsage: insert failed", { error: err.message });
  }
}

// ---------------------------------------------------------------------------
// Summary query
// ---------------------------------------------------------------------------

/**
 * Return aggregated AI cost broken down by model, tool, and period.
 */
export async function getAiCostSummary() {
  const [byModel, byTool, today, week, month] = await Promise.all([
    pool.query(`
      SELECT model,
             SUM(input_tokens)::int              AS total_input_tokens,
             SUM(output_tokens)::int             AS total_output_tokens,
             ROUND(SUM(estimated_cost_usd), 6)   AS total_cost_usd,
             COUNT(*)::int                       AS call_count
      FROM   ai_usage
      GROUP  BY model
      ORDER  BY total_cost_usd DESC
    `),
    pool.query(`
      SELECT tool_name,
             SUM(input_tokens)::int              AS total_input_tokens,
             SUM(output_tokens)::int             AS total_output_tokens,
             ROUND(SUM(estimated_cost_usd), 6)   AS total_cost_usd,
             COUNT(*)::int                       AS call_count
      FROM   ai_usage
      GROUP  BY tool_name
      ORDER  BY total_cost_usd DESC
    `),
    pool.query(`
      SELECT SUM(input_tokens)::int            AS total_input_tokens,
             SUM(output_tokens)::int           AS total_output_tokens,
             ROUND(SUM(estimated_cost_usd), 6) AS total_cost_usd,
             COUNT(*)::int                     AS call_count
      FROM   ai_usage
      WHERE  created_at >= NOW() - INTERVAL '24 hours'
    `),
    pool.query(`
      SELECT SUM(input_tokens)::int            AS total_input_tokens,
             SUM(output_tokens)::int           AS total_output_tokens,
             ROUND(SUM(estimated_cost_usd), 6) AS total_cost_usd,
             COUNT(*)::int                     AS call_count
      FROM   ai_usage
      WHERE  created_at >= NOW() - INTERVAL '7 days'
    `),
    pool.query(`
      SELECT SUM(input_tokens)::int            AS total_input_tokens,
             SUM(output_tokens)::int           AS total_output_tokens,
             ROUND(SUM(estimated_cost_usd), 6) AS total_cost_usd,
             COUNT(*)::int                     AS call_count
      FROM   ai_usage
      WHERE  created_at >= NOW() - INTERVAL '30 days'
    `),
  ]);

  return {
    by_model: byModel.rows,
    by_tool:  byTool.rows,
    by_period: {
      today: today.rows[0],
      week:  week.rows[0],
      month: month.rows[0],
    },
  };
}
