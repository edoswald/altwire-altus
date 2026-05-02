/**
 * ai-cost-tracker.js
 *
 * Tracks Anthropic API usage and estimated cost in PostgreSQL.
 *
 * Rates (hardcoded — update when Anthropic pricing changes):
 *   claude-haiku-4-5: input $0.80/M tokens, output $4.00/M tokens
 */

import pool from "./altus-db.js";
import { logger } from "../logger.js";

// ---------------------------------------------------------------------------
// Pricing table ($ per 1M tokens)
// ---------------------------------------------------------------------------

const PRICING = {
  "claude-haiku-4-5-20251001": { input: 0.80, output: 4.00 },
  "claude-haiku-4-5-20250514": { input: 0.80, output: 4.00 },
  "claude-haiku-4-5":          { input: 0.80, output: 4.00 },
};

function calcCost(model, inputTokens, outputTokens) {
  // Exact match first, then prefix match.
  let price = PRICING[model];
  if (!price) {
    for (const [key, p] of Object.entries(PRICING)) {
      if (model.startsWith(key) || key.startsWith(model)) { price = p; break; }
    }
  }
  if (!price) return 0; // Unknown model — record tokens but no cost estimate.
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
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
 * @param {{ input_tokens: number, output_tokens: number }} usage  From response.usage
 */
export async function logAiUsage(toolName, model, usage) {
  if (!process.env.DATABASE_URL) return;
  try {
    const inputTokens  = usage?.input_tokens  ?? 0;
    const outputTokens = usage?.output_tokens ?? 0;
    const cost         = calcCost(model, inputTokens, outputTokens);
    await pool.query(
      `INSERT INTO ai_usage (tool_name, model, input_tokens, output_tokens, estimated_cost_usd)
       VALUES ($1, $2, $3, $4, $5)`,
      [toolName, model, inputTokens, outputTokens, cost],
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
