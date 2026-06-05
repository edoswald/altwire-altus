import pool, { hasDbConfig } from '../lib/altus-db.js';
import { logger } from '../logger.js';

const VALID_COMMITMENT_STATUSES = new Set(['open', 'completed', 'blocked', 'cancelled']);
const VALID_WATCH_STATUSES = new Set(['active', 'resolved', 'cancelled']);

function clampLimit(limit, fallback = 20) {
  return Math.min(Math.max(Number(limit ?? fallback), 1), 100);
}

function parseDateOrNull(value, fieldName) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return { error: `${fieldName} must be an ISO datetime` };
  }
  return parsed.toISOString();
}

export async function initCommitmentsSchema() {
  if (!hasDbConfig()) {
    logger.warn('altus-commitments: database URL not set, skipping schema init');
    return;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS altus_commitments (
      id SERIAL PRIMARY KEY,
      admin_id INTEGER,
      client_id VARCHAR(255),
      title VARCHAR(200) NOT NULL,
      description TEXT DEFAULT '',
      due_at TIMESTAMPTZ,
      status VARCHAR(20) NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'completed', 'blocked', 'cancelled')),
      source VARCHAR(100) NOT NULL DEFAULT 'manual',
      evidence TEXT,
      outcome_notes TEXT,
      session_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      cancelled_at TIMESTAMPTZ
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_altus_commitments_open_due
      ON altus_commitments (status, due_at)
      WHERE status = 'open'
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS altus_watch_items (
      id SERIAL PRIMARY KEY,
      admin_id INTEGER,
      client_id VARCHAR(255),
      title VARCHAR(200) NOT NULL,
      description TEXT DEFAULT '',
      cadence VARCHAR(100) DEFAULT 'as-needed',
      next_check_at TIMESTAMPTZ,
      status VARCHAR(20) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'resolved', 'cancelled')),
      source VARCHAR(100) NOT NULL DEFAULT 'manual',
      evidence TEXT,
      outcome_notes TEXT,
      session_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at TIMESTAMPTZ,
      cancelled_at TIMESTAMPTZ
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_altus_watch_items_active_next_check
      ON altus_watch_items (status, next_check_at)
      WHERE status = 'active'
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS altus_autonomy_notes (
      id SERIAL PRIMARY KEY,
      admin_id INTEGER,
      client_id VARCHAR(255),
      note_type VARCHAR(100) NOT NULL DEFAULT 'general',
      body TEXT NOT NULL,
      source VARCHAR(100) NOT NULL DEFAULT 'autonomy',
      evidence TEXT,
      session_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  logger.info('altus-commitments: schema ready');
}

export async function recordCommitment({
  admin_id = null,
  client_id = null,
  title,
  description = '',
  due_at = null,
  source = 'manual',
  evidence = null,
  session_id = null,
} = {}) {
  if (!hasDbConfig()) return { success: false, exit_reason: 'config_error' };
  if (!title || !title.trim()) return { success: false, exit_reason: 'validation_error', message: 'title is required' };
  const parsedDue = parseDateOrNull(due_at, 'due_at');
  if (parsedDue?.error) return { success: false, exit_reason: 'validation_error', message: parsedDue.error };
  if (process.env.TEST_MODE === 'true') return { success: true, test_mode: true, commitment_id: 0 };

  const { rows } = await pool.query(
    `INSERT INTO altus_commitments (admin_id, client_id, title, description, due_at, source, evidence, session_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [admin_id, client_id, title.trim().slice(0, 200), description ?? '', parsedDue, source.slice(0, 100), evidence, session_id],
  );
  return { success: true, commitment: rows[0], commitment_id: rows[0]?.id };
}

export async function listCommitments({ status = 'open', overdue = false, limit = 20 } = {}) {
  if (!hasDbConfig()) return { success: false, exit_reason: 'config_error' };
  if (!VALID_COMMITMENT_STATUSES.has(status)) return { success: false, exit_reason: 'validation_error', message: 'invalid status' };
  const conditions = ['status = $1'];
  if (overdue) conditions.push('due_at IS NOT NULL AND due_at <= NOW()');
  const params = [status, clampLimit(limit)];
  const { rows } = await pool.query(
    `SELECT *
       FROM altus_commitments
      WHERE ${conditions.join(' AND ')}
      ORDER BY due_at NULLS LAST, created_at ASC
      LIMIT $2`,
    params,
  );
  return { success: true, commitments: rows, count: rows.length };
}

export async function updateCommitment({ commitment_id, status, evidence = null, outcome_notes = null } = {}) {
  if (!hasDbConfig()) return { success: false, exit_reason: 'config_error' };
  if (!VALID_COMMITMENT_STATUSES.has(status)) return { success: false, exit_reason: 'validation_error', message: 'invalid status' };
  if (process.env.TEST_MODE === 'true') return { success: true, test_mode: true, commitment_id };

  const terminalClause = status === 'completed'
    ? ', completed_at = NOW(), cancelled_at = NULL'
    : status === 'cancelled'
      ? ', cancelled_at = NOW()'
      : '';

  const { rows } = await pool.query(
    `UPDATE altus_commitments
        SET status = $1,
            evidence = COALESCE($2, evidence),
            outcome_notes = COALESCE($3, outcome_notes),
            updated_at = NOW()
            ${terminalClause}
      WHERE id = $4
      RETURNING *`,
    [status, evidence, outcome_notes, commitment_id],
  );

  if (rows.length === 0) return { success: false, exit_reason: 'not_found' };
  return { success: true, commitment: rows[0] };
}

export async function recordWatchItem({
  admin_id = null,
  client_id = null,
  title,
  description = '',
  cadence = 'as-needed',
  next_check_at = null,
  source = 'manual',
  evidence = null,
  session_id = null,
} = {}) {
  if (!hasDbConfig()) return { success: false, exit_reason: 'config_error' };
  if (!title || !title.trim()) return { success: false, exit_reason: 'validation_error', message: 'title is required' };
  const parsedNext = parseDateOrNull(next_check_at, 'next_check_at');
  if (parsedNext?.error) return { success: false, exit_reason: 'validation_error', message: parsedNext.error };
  if (process.env.TEST_MODE === 'true') return { success: true, test_mode: true, watch_item_id: 0 };

  const { rows } = await pool.query(
    `INSERT INTO altus_watch_items (admin_id, client_id, title, description, cadence, next_check_at, source, evidence, session_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [admin_id, client_id, title.trim().slice(0, 200), description ?? '', cadence.slice(0, 100), parsedNext, source.slice(0, 100), evidence, session_id],
  );
  return { success: true, watch_item: rows[0], watch_item_id: rows[0]?.id };
}

export async function listWatchItems({ status = 'active', due = false, limit = 20 } = {}) {
  if (!hasDbConfig()) return { success: false, exit_reason: 'config_error' };
  if (!VALID_WATCH_STATUSES.has(status)) return { success: false, exit_reason: 'validation_error', message: 'invalid status' };
  const conditions = ['status = $1'];
  if (due) conditions.push('next_check_at IS NOT NULL AND next_check_at <= NOW()');
  const params = [status, clampLimit(limit)];
  const { rows } = await pool.query(
    `SELECT *
       FROM altus_watch_items
      WHERE ${conditions.join(' AND ')}
      ORDER BY next_check_at NULLS LAST, created_at ASC
      LIMIT $2`,
    params,
  );
  return { success: true, watch_items: rows, count: rows.length };
}

export async function updateWatchItem({ watch_item_id, status, next_check_at = null, evidence = null, outcome_notes = null } = {}) {
  if (!hasDbConfig()) return { success: false, exit_reason: 'config_error' };
  if (!VALID_WATCH_STATUSES.has(status)) return { success: false, exit_reason: 'validation_error', message: 'invalid status' };
  const parsedNext = parseDateOrNull(next_check_at, 'next_check_at');
  if (parsedNext?.error) return { success: false, exit_reason: 'validation_error', message: parsedNext.error };
  if (process.env.TEST_MODE === 'true') return { success: true, test_mode: true, watch_item_id };

  const terminalClause = status === 'resolved'
    ? ', resolved_at = NOW(), cancelled_at = NULL'
    : status === 'cancelled'
      ? ', cancelled_at = NOW()'
      : '';

  const { rows } = await pool.query(
    `UPDATE altus_watch_items
        SET status = $1,
            next_check_at = COALESCE($2, next_check_at),
            evidence = COALESCE($3, evidence),
            outcome_notes = COALESCE($4, outcome_notes),
            updated_at = NOW()
            ${terminalClause}
      WHERE id = $5
      RETURNING *`,
    [status, parsedNext, evidence, outcome_notes, watch_item_id],
  );

  if (rows.length === 0) return { success: false, exit_reason: 'not_found' };
  return { success: true, watch_item: rows[0] };
}

export async function recordAutonomyNote({
  admin_id = null,
  client_id = null,
  note_type = 'general',
  body,
  source = 'autonomy',
  evidence = null,
  session_id = null,
} = {}) {
  if (!hasDbConfig()) return { success: false, exit_reason: 'config_error' };
  if (!body || !body.trim()) return { success: false, exit_reason: 'validation_error', message: 'body is required' };
  if (process.env.TEST_MODE === 'true') return { success: true, test_mode: true, note_id: 0 };

  const { rows } = await pool.query(
    `INSERT INTO altus_autonomy_notes (admin_id, client_id, note_type, body, source, evidence, session_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [admin_id, client_id, note_type.slice(0, 100), body.trim(), source.slice(0, 100), evidence, session_id],
  );
  return { success: true, note: rows[0], note_id: rows[0]?.id };
}
