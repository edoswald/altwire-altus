/**
 * altus-event-log.js
 *
 * Unified, queryable record of everything Altus does.
 * Adapted from cirrusly-nimbus/hal-event-log.js for AltWire editorial context.
 *
 * Exports: initAltusEventLogSchema, logAltusEvent, queryAltusEvents,
 *          synthesizeAudit, runAuditBatchCollection, runRetentionCron
 */

import Anthropic from '@anthropic-ai/sdk';
import pool from './lib/altus-db.js';
import { logger } from './logger.js';
import { logAiUsage } from './lib/ai-cost-tracker.js';
import { submitBatch, collectBatch } from './batch-client.js';

const MAX_PAYLOAD_BYTES = 10 * 1024;

export async function initAltusEventLogSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS altus_events (
      id            BIGSERIAL     PRIMARY KEY,
      event_type    VARCHAR(20)   NOT NULL
                    CHECK (event_type IN ('tool_call', 'tool_error', 'cron_trigger', 'session_start', 'session_end', 'scope_denied')),
      tool_name     VARCHAR(100),
      session_id    INTEGER,
      payload       JSONB,
      error_message TEXT,
      duration_ms   INTEGER,
      created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS altus_events_created_at_idx
      ON altus_events (created_at DESC)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS altus_events_tool_created_idx
      ON altus_events (tool_name, created_at DESC)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS altus_events_session_created_idx
      ON altus_events (session_id, created_at DESC)
      WHERE session_id IS NOT NULL
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS altus_audit_batches (
      id            SERIAL        PRIMARY KEY,
      batch_id      VARCHAR(100)  NOT NULL UNIQUE,
      requested_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      window_hours  INTEGER       NOT NULL,
      status        VARCHAR(20)   NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'complete', 'error')),
      narrative     TEXT,
      completed_at  TIMESTAMPTZ
    )
  `);
}

export async function logAltusEvent(eventType, options = {}) {
  if (process.env.TEST_MODE === 'true') return;

  const { tool_name, session_id, payload, error_message, duration_ms } = options;

  const safeEventType = typeof eventType === 'string' ? eventType.substring(0, 20) : eventType;

  let storedPayload = payload ?? null;
  if (storedPayload !== null) {
    const payloadJson = JSON.stringify(storedPayload);
    const byteLen = Buffer.byteLength(payloadJson, 'utf8');
    if (byteLen > MAX_PAYLOAD_BYTES) {
      storedPayload = { truncated: true, original_size_bytes: byteLen };
    }
  }

  try {
    await pool.query(
      `INSERT INTO altus_events
         (event_type, tool_name, session_id, payload, error_message, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        safeEventType,
        tool_name ?? null,
        session_id ?? null,
        storedPayload !== null ? JSON.stringify(storedPayload) : null,
        error_message ?? null,
        duration_ms ?? null,
      ],
    );
  } catch (err) {
    logger.error('logAltusEvent: insert failed', { error: err.message });
  }
}

export async function queryAltusEvents(filters = {}) {
  const { event_type, tool_name, session_id, last_n_hours, limit } = filters;

  const conditions = [];
  const params = [];

  if (event_type !== undefined && event_type !== null) {
    params.push(event_type);
    conditions.push(`event_type = $${params.length}`);
  }

  if (tool_name !== undefined && tool_name !== null) {
    params.push(tool_name);
    conditions.push(`tool_name = $${params.length}`);
  }

  if (session_id !== undefined && session_id !== null) {
    params.push(session_id);
    conditions.push(`session_id = $${params.length}`);
  }

  if (last_n_hours !== undefined && last_n_hours !== null) {
    const n = Math.max(1, Math.min(168, Math.floor(Number(last_n_hours))));
    conditions.push(`created_at >= NOW() - INTERVAL '${n} hours'`);
  }

  const resolvedLimit = Math.min(200, Math.max(1, Number(limit) || 50));

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(resolvedLimit);
  const sql = `SELECT * FROM altus_events ${where} ORDER BY created_at DESC LIMIT $${params.length}`;

  const result = await pool.query(sql, params);
  return { success: true, events: result.rows, count: result.rows.length };
}

export async function synthesizeAudit(options = {}) {
  const { last_n_hours, batch_id } = options;

  if (batch_id) {
    const batchRow = await pool.query(
      `SELECT * FROM altus_audit_batches WHERE batch_id = $1`,
      [batch_id],
    );
    if (batchRow.rows.length === 0) {
      return { success: false, exit_reason: 'not_found', message: 'Batch ID not found.' };
    }
    const row = batchRow.rows[0];
    if (row.status === 'complete') {
      return { success: true, narrative: row.narrative, event_count: row.window_hours };
    }
    if (row.status === 'pending') {
      return {
        success: true,
        mode: 'batch',
        batch_id,
        message: 'Audit synthesis still processing — check back in a few minutes.',
      };
    }
    return { success: false, exit_reason: 'batch_error', message: `Batch status: ${row.status}` };
  }

  const hours = Math.max(1, Math.min(168, Math.floor(Number(last_n_hours) || 24)));

  const eventsResult = await pool.query(
    `SELECT * FROM altus_events WHERE created_at >= NOW() - INTERVAL '${hours} hours' ORDER BY created_at ASC`,
  );
  const events = eventsResult.rows;

  if (events.length === 0) {
    return { success: true, narrative: 'No events recorded in this time window.', event_count: 0 };
  }

  const eventsJson = JSON.stringify(events, null, 2);
  const prompt = `Summarise the following Altus agent events in plain English for a non-technical reader.\nInclude: tool calls made, any errors, cron jobs that fired, and session boundaries.\nBe chronological and concise.\n\n<events>${eventsJson}</events>`;

  if (hours <= 24) {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    });
    await logAiUsage('synthesize_audit', response.model ?? 'claude-haiku-4-5', response.usage);
    const narrative = response.content?.[0]?.text ?? '';
    return { success: true, mode: 'direct', narrative, event_count: events.length };
  }

  const model = process.env.ANTHROPIC_BATCH_REVIEW_MODEL ?? 'claude-opus-4-6';
  const requests = [
    {
      custom_id: 'pending',
      params: {
        model,
        max_tokens: 2048,
        messages: [{ role: 'user', content: prompt }],
      },
    },
  ];

  const insertResult = await pool.query(
    `INSERT INTO altus_audit_batches (batch_id, window_hours, status)
     VALUES ($1, $2, 'pending') RETURNING id`,
    ['pending_placeholder', hours],
  );
  const rowId = insertResult.rows[0].id;

  requests[0].custom_id = String(rowId);

  const newBatchId = await submitBatch(requests);

  await pool.query(
    `UPDATE altus_audit_batches SET batch_id = $1 WHERE id = $2`,
    [newBatchId, rowId],
  );

  return {
    success: true,
    mode: 'batch',
    batch_id: newBatchId,
    message: 'Audit synthesis queued — check back in a few minutes.',
  };
}

export async function runAuditBatchCollection() {
  const pending = await pool.query(
    `SELECT * FROM altus_audit_batches WHERE status = 'pending'`,
  );

  for (const row of pending.rows) {
    try {
      const results = await collectBatch(row.batch_id);
      if (results === null) continue;

      const succeeded = results.find(r => r.result?.type === 'succeeded');
      const narrative = succeeded?.result?.message?.content?.[0]?.text ?? '';

      await pool.query(
        `UPDATE altus_audit_batches
         SET narrative = $1, status = 'complete', completed_at = NOW()
         WHERE id = $2`,
        [narrative, row.id],
      );
    } catch (err) {
      logger.error('runAuditBatchCollection: collectBatch failed', {
        batch_id: row.batch_id,
        error: err.message,
      });
    }
  }
}

export async function runRetentionCron() {
  logAltusEvent('cron_trigger', { payload: { cron_name: 'altus_event_retention' } });

  try {
    const eventsResult = await pool.query(
      `DELETE FROM altus_events WHERE created_at < NOW() - INTERVAL '30 days'`,
    );
    logger.info('runRetentionCron: pruned altus_events', { deleted: eventsResult.rowCount });

    const batchesResult = await pool.query(
      `DELETE FROM altus_audit_batches WHERE requested_at < NOW() - INTERVAL '30 days'`,
    );
    logger.info('runRetentionCron: pruned altus_audit_batches', { deleted: batchesResult.rowCount });
  } catch (err) {
    logger.error('runRetentionCron: pruning failed', { error: err.message });
  }
}