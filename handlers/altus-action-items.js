import pool, { readAgentMemory, writeAgentMemory } from '../lib/altus-db.js';
import { logger } from '../logger.js';

const MAX_WINS = 25;

const VALID_TRANSITIONS = {
  proposed: ['accepted', 'completed', 'dismissed'],
  accepted: ['completed', 'dismissed'],
  completed: [],
  dismissed: [],
};

const ACTION_TO_STATUS = {
  accept: 'accepted',
  complete: 'completed',
  dismiss: 'dismissed',
};

function formatActionItemWin(item) {
  const title = String(item?.title ?? '').trim();
  if (!title) return '';

  const notes = String(item?.outcome_notes ?? '').trim();
  if (!notes || notes === title) {
    return `Completed: ${title}`;
  }

  return `Completed: ${title} - ${notes}`;
}

async function appendActionItemWin(item) {
  const winText = formatActionItemWin(item);
  if (!winText) return;

  const existing = await readAgentMemory('hal', 'reflection:wins').catch(() => null);
  let current = [];

  if (existing?.success && existing.value) {
    try {
      current = JSON.parse(existing.value);
    } catch {
      current = [];
    }
  }

  if (!Array.isArray(current)) current = [];

  const updated = [...current, winText].slice(-MAX_WINS);
  await writeAgentMemory('hal', 'reflection:wins', JSON.stringify(updated));
}

export async function initActionItemsSchema() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS altus_action_items (
        id              SERIAL PRIMARY KEY,
        title           VARCHAR(200)  NOT NULL,
        description     TEXT          NOT NULL,
        category        VARCHAR(20)   NOT NULL
                        CHECK (category IN ('marketing', 'operations', 'pricing', 'quality', 'infrastructure', 'editorial')),
        signal_source   VARCHAR(100)  NOT NULL,
        signal_data     TEXT,
        proposed_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        status          VARCHAR(20)   NOT NULL DEFAULT 'proposed'
                        CHECK (status IN ('proposed', 'accepted', 'completed', 'dismissed')),
        accepted_at     TIMESTAMPTZ,
        completed_at    TIMESTAMPTZ,
        dismissed_at    TIMESTAMPTZ,
        dismiss_reason  TEXT,
        outcome_notes   TEXT,
        reflection_date DATE          NOT NULL
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_altus_action_items_status_proposed
        ON altus_action_items (status, proposed_at)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_altus_action_items_category_status
        ON altus_action_items (category, status)
    `);

    logger.info('initActionItemsSchema: altus_action_items table ready');
  } finally {
    client.release();
  }
}

export async function listActionItems({ status = 'proposed', category, limit = 20 } = {}) {
  if (!process.env.DATABASE_URL) {
    return { success: false, exit_reason: 'config_error' };
  }

  const conditions = ['status = $1'];
  const params = [status];

  if (category) {
    params.push(category);
    conditions.push(`category = $${params.length}`);
  }

  params.push(Math.min(Math.max(limit, 1), 100));

  const sql = `SELECT * FROM altus_action_items WHERE ${conditions.join(' AND ')} ORDER BY proposed_at DESC LIMIT $${params.length}`;
  const { rows } = await pool.query(sql, params);
  return { success: true, items: rows, count: rows.length };
}

export async function getActionItemStats() {
  if (!process.env.DATABASE_URL) {
    return { success: false, exit_reason: 'config_error' };
  }

  const { rows } = await pool.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status = 'proposed')::int AS proposed,
      COUNT(*) FILTER (WHERE status = 'accepted')::int AS accepted,
      COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
      COUNT(*) FILTER (WHERE status = 'dismissed')::int AS dismissed
    FROM altus_action_items
  `);

  return { success: true, stats: rows[0] ?? { total: 0, proposed: 0, accepted: 0, completed: 0, dismissed: 0 } };
}

export async function manageActionItem({ item_id, action, reason, outcome_notes } = {}) {
  if (!process.env.DATABASE_URL) {
    return { success: false, exit_reason: 'config_error' };
  }

  const targetStatus = ACTION_TO_STATUS[action];
  if (!targetStatus) {
    return { success: false, exit_reason: 'invalid_transition' };
  }

  const current = await pool.query(
    'SELECT * FROM altus_action_items WHERE id = $1',
    [item_id],
  );

  if (current.rows.length === 0) {
    return { success: false, exit_reason: 'not_found' };
  }

  const item = current.rows[0];
  if (!VALID_TRANSITIONS[item.status]?.includes(targetStatus)) {
    return { success: false, exit_reason: 'invalid_transition', current_status: item.status };
  }

  const updates = ['status = $1', 'outcome_notes = COALESCE($2, outcome_notes)', 'dismiss_reason = COALESCE($3, dismiss_reason)'];
  const params = [targetStatus, outcome_notes ?? null, reason ?? null];

  if (targetStatus === 'accepted') updates.push('accepted_at = NOW()');
  if (targetStatus === 'completed') updates.push('completed_at = NOW()');
  if (targetStatus === 'dismissed') updates.push('dismissed_at = NOW()');

  params.push(item_id);

  const result = await pool.query(
    `UPDATE altus_action_items SET ${updates.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params,
  );

  if (targetStatus === 'completed') {
    try {
      await appendActionItemWin(result.rows[0]);
    } catch (err) {
      logger.warn('manageActionItem: failed to record completion win', {
        item_id,
        error: err.message,
      });
    }
  }

  return { success: true, item: result.rows[0] };
}

export async function acceptStaleProposedItems(limit = 10) {
  const staleResult = await pool.query(
    `SELECT id
       FROM altus_action_items
      WHERE status = 'proposed'
        AND proposed_at < NOW() - INTERVAL '24 hours'
      ORDER BY proposed_at ASC
      LIMIT $1`,
    [limit],
  );

  let queued = 0;
  for (const item of staleResult.rows) {
    await pool.query(
      `UPDATE altus_action_items
          SET status = 'accepted', accepted_at = NOW()
        WHERE id = $1 AND status = 'proposed'`,
      [item.id],
    );
    queued++;
  }

  return queued;
}

export async function createActionItemFromScheduledTask(task = {}) {
  const payload = task.payload ?? {};
  const result = await pool.query(
    `INSERT INTO altus_action_items (title, description, category, signal_source, signal_data, reflection_date)
     VALUES ($1, $2, $3, $4, $5, CURRENT_DATE)
     RETURNING id`,
    [
      payload.title ?? 'Scheduled action',
      payload.description ?? '',
      payload.category ?? 'operations',
      'heartbeat_scheduled',
      JSON.stringify(payload),
    ],
  );

  return { success: true, item_id: result.rows[0]?.id ?? null };
}
