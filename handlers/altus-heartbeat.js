/**
 * handlers/altus-heartbeat.js
 *
 * Altus's autonomous action loop — runs every 2 hours via cron.
 *
 * Adapted from cirrusly-nimbus/hal-heartbeat.js for AltWire editorial context.
 *
 * PHILOSOPHY: Most heartbeat runs should do nothing. That is correct behavior.
 * The heartbeat is Altus's reserved time to act — and like any competent operator,
 * Altus should choose *when* to act based on whether conditions are right, not
 * just whether a slot is available. An empty run is a healthy run.
 *
 * Run sequence:
 *   Step 0 — Pick up scheduled tasks that are due
 *   Step 1 — Condition checks (AI costs, review deadlines, loaner returns)
 *   Step 2 — Send alerts for breached conditions (with 6h dedup)
 *   Step 3 — Queue stale proposed items for human review (proposed > 24h old)
 *   Step 4 — Write heartbeat log + memory key
 *
 * Exports: initHeartbeatSchema, runAltusHeartbeat,
 *          scheduleAltusTask, listScheduledTasks, cancelScheduledTask
 */

import pool from '../lib/altus-db.js';
import { logger } from '../logger.js';
import { readAgentMemory, writeAgentMemory } from '../lib/altus-db.js';
import { logAltusEvent } from '../altus-event-log.js';

const HEARTBEAT_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours

// ---------------------------------------------------------------------------
// Schema init — exported for startup registration
// ---------------------------------------------------------------------------

export async function initHeartbeatSchema() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS altus_heartbeat_log (
        id               SERIAL PRIMARY KEY,
        run_at           TIMESTAMPTZ DEFAULT NOW(),
        duration_ms      INTEGER,
        items_evaluated  INTEGER DEFAULT 0,
        items_acted      INTEGER DEFAULT 0,
        items_queued     INTEGER DEFAULT 0,
        items_skipped    INTEGER DEFAULT 0,
        alerts_sent      INTEGER DEFAULT 0,
        condition_checks TEXT,
        error_message    TEXT
      )
    `);
    // Safe migration: add condition_checks column if it doesn't exist (backward compatibility)
    await client.query(`
      ALTER TABLE altus_heartbeat_log ADD COLUMN IF NOT EXISTS condition_checks TEXT
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS altus_scheduled_tasks (
        id            SERIAL PRIMARY KEY,
        task_type     VARCHAR(50)  NOT NULL,
        payload       JSONB DEFAULT '{}',
        due_at        TIMESTAMPTZ  NOT NULL,
        status        VARCHAR(20)  NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'running', 'completed', 'failed', 'skipped')),
        created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        started_at    TIMESTAMPTZ,
        completed_at  TIMESTAMPTZ,
        error_message TEXT,
        metadata      JSONB
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS altus_scheduled_tasks_due_at_idx
        ON altus_scheduled_tasks (due_at ASC)
        WHERE status = 'pending'
    `);

    logger.info('initHeartbeatSchema: tables ready');
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Scheduled task management
// ---------------------------------------------------------------------------

/**
 * Schedule a task for future heartbeat execution.
 *
 * @param {object} opts
 * @param {string} opts.task_type — e.g. 'action_item', 'report', 'alert'
 * @param {object} [opts.payload] — JSON payload
 * @param {string} opts.due_at — ISO 8601 timestamp
 * @param {object} [opts.metadata] — additional metadata
 * @returns {Promise<{ success: boolean, task_id?: number, exit_reason?: string }>}
 */
export async function scheduleAltusTask({ task_type, payload = {}, due_at, metadata = {} } = {}) {
  const parsedDate = new Date(due_at);
  if (isNaN(parsedDate.getTime())) {
    return { success: false, exit_reason: 'validation_error', message: 'due_at must be a valid ISO timestamp' };
  }

  if (!task_type || !task_type.trim()) {
    return { success: false, exit_reason: 'validation_error', message: 'task_type is required' };
  }

  try {
    const result = await pool.query(
      `INSERT INTO altus_scheduled_tasks (task_type, payload, due_at, metadata)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [task_type, JSON.stringify(payload), parsedDate, JSON.stringify(metadata)],
    );
    return { success: true, task_id: result.rows[0].id };
  } catch (err) {
    logger.error('scheduleAltusTask: insert failed', { error: err.message });
    return { success: false, exit_reason: 'db_error', message: err.message };
  }
}

/**
 * List pending scheduled tasks due before a given time.
 *
 * @param {number} [beforeMinutes=0] — only tasks due within this many minutes from now
 * @returns {Promise<Array>}
 */
export async function listScheduledTasks(beforeMinutes = 0) {
  const cutoff = new Date(Date.now() + beforeMinutes * 60 * 1000);
  const result = await pool.query(
    `SELECT * FROM altus_scheduled_tasks
      WHERE status = 'pending'
        AND due_at <= $1
      ORDER BY due_at ASC
      LIMIT 20`,
    [cutoff],
  );
  return result.rows;
}

/**
 * Cancel a scheduled task.
 *
 * @param {number} taskId
 * @returns {Promise<{ success: boolean }>}
 */
export async function cancelScheduledTask(taskId) {
  await pool.query(
    `UPDATE altus_scheduled_tasks SET status = 'skipped', completed_at = NOW() WHERE id = $1`,
    [taskId],
  );
  return { success: true };
}

// ---------------------------------------------------------------------------
// Step 1 — condition checks (placeholder for editorial-specific checks)
// ---------------------------------------------------------------------------

async function checkConditions() {
  const conditions = {};
  const now = new Date();

  // Check: upcoming review deadlines (within 7 days)
  const upcomingResult = await pool.query(
    `SELECT COUNT(*) as count FROM altus_reviews
      WHERE status IN ('assigned', 'in_progress')
        AND due_date IS NOT NULL
        AND due_date <= CURRENT_DATE + INTERVAL '7 days'`,
  );
  conditions.upcoming_review_deadlines = parseInt(upcomingResult.rows[0].count, 10);

  // Check: overdue loaners
  const overdueResult = await pool.query(
    `SELECT COUNT(*) as count FROM altus_loaners
      WHERE status = 'out'
        AND expected_return_date < CURRENT_DATE`,
  );
  conditions.overdue_loaners = parseInt(overdueResult.rows[0].count, 10);

  // Check: proposed action items older than 48 hours
  const staleResult = await pool.query(
    `SELECT COUNT(*) as count FROM altus_action_items
      WHERE status = 'proposed'
        AND proposed_at < NOW() - INTERVAL '48 hours'`,
  );
  conditions.stale_proposed_items = parseInt(staleResult.rows[0].count, 10);

  return conditions;
}

// ---------------------------------------------------------------------------
// Step 2 — alert dedup (6-hour window)
// ---------------------------------------------------------------------------

async function shouldSendAlert(alertKey) {
  const memoryKey = `altus:heartbeat:alert_dedup`;
  const result = await readAgentMemory('altus', memoryKey);
  const registry = result.success ? JSON.parse(result.value) : {};
  const last = registry[alertKey];
  if (last && (Date.now() - new Date(last).getTime()) < 6 * 60 * 60 * 1000) {
    return false;
  }
  return true;
}

async function recordAlertSent(alertKey) {
  const memoryKey = `altus:heartbeat:alert_dedup`;
  const result = await readAgentMemory('altus', memoryKey);
  const registry = result.success ? JSON.parse(result.value) : {};
  registry[alertKey] = new Date().toISOString();
  await writeAgentMemory('altus', memoryKey, JSON.stringify(registry));
}

// ---------------------------------------------------------------------------
// Step 3 — queue stale proposed items
// ---------------------------------------------------------------------------

async function queueStaleProposedItems() {
  const staleResult = await pool.query(
    `SELECT id, title, category FROM altus_action_items
      WHERE status = 'proposed'
        AND proposed_at < NOW() - INTERVAL '24 hours'
      ORDER BY proposed_at ASC
      LIMIT 10`,
  );

  let queued = 0;
  for (const item of staleResult.rows) {
    await pool.query(
      `UPDATE altus_action_items SET status = 'accepted' WHERE id = $1 AND status = 'proposed'`,
      [item.id],
    );
    queued++;
  }

  return queued;
}

// ---------------------------------------------------------------------------
// Main heartbeat run
// ---------------------------------------------------------------------------

/**
 * Run one cycle of the Altus heartbeat.
 *
 * @returns {Promise<{ items_evaluated: number, items_acted: number, items_queued: number, items_skipped: number, alerts_sent: number }>}
 */
export async function runAltusHeartbeat() {
  const start = Date.now();
  const counters = { items_evaluated: 0, items_acted: 0, items_queued: 0, items_skipped: 0, alerts_sent: 0 };

  logAltusEvent('cron_trigger', { payload: { cron_name: 'altus_heartbeat' } });

  try {
    // Step 0 — pick up due scheduled tasks
    const dueTasks = await listScheduledTasks(0);
    for (const task of dueTasks) {
      counters.items_evaluated++;
      try {
        await pool.query(
          `UPDATE altus_scheduled_tasks SET status = 'running', started_at = NOW() WHERE id = $1`,
          [task.id],
        );

        if (task.task_type === 'action_item') {
          await pool.query(
            `INSERT INTO altus_action_items (title, description, category, signal_source, signal_data, reflection_date)
              VALUES ($1, $2, $3, $4, $5, CURRENT_DATE)`,
            [task.payload.title ?? 'Scheduled action', task.payload.description ?? '', task.payload.category ?? 'operations', 'heartbeat_scheduled', JSON.stringify(task.payload)],
          );
          counters.items_acted++;
        }

        await pool.query(
          `UPDATE altus_scheduled_tasks SET status = 'completed', completed_at = NOW() WHERE id = $1`,
          [task.id],
        );
      } catch (err) {
        await pool.query(
          `UPDATE altus_scheduled_tasks SET status = 'failed', error_message = $1, completed_at = NOW() WHERE id = $2`,
          [err.message, task.id],
        );
        counters.items_skipped++;
      }
    }

    // Step 1 — condition checks
    const conditions = await checkConditions();

    // Step 2 — send alerts for breached conditions (with 6h dedup)
    const breached = [];
    if (conditions.upcoming_review_deadlines > 0) {
      breached.push({ key: 'upcoming_review_deadlines', count: conditions.upcoming_review_deadlines });
    }
    if (conditions.overdue_loaners > 0) {
      breached.push({ key: 'overdue_loaners', count: conditions.overdue_loaners });
    }
    if (conditions.stale_proposed_items > 0) {
      breached.push({ key: 'stale_proposed_items', count: conditions.stale_proposed_items });
    }

    for (const alert of breached) {
      if (await shouldSendAlert(alert.key)) {
        counters.alerts_sent++;
        await recordAlertSent(alert.key);
        logger.info('runAltusHeartbeat: alert triggered', { alert: alert.key, count: alert.count });
      }
    }

    // Step 3 — queue stale proposed items
    if (conditions.stale_proposed_items > 0) {
      counters.items_queued = await queueStaleProposedItems();
    }

    // Step 4 — write heartbeat log
    const durationMs = Date.now() - start;
    await pool.query(
      `INSERT INTO altus_heartbeat_log (run_at, duration_ms, items_evaluated, items_acted, items_queued, items_skipped, alerts_sent, condition_checks)
       VALUES (NOW(), $1, $2, $3, $4, $5, $6, $7)`,
      [durationMs, counters.items_evaluated, counters.items_acted, counters.items_queued, counters.items_skipped, counters.alerts_sent, JSON.stringify(conditions)],
    );

    // Update heartbeat memory key for session visibility
    await writeAgentMemory('altus', 'altus:heartbeat:last_run', JSON.stringify({
      run_at: new Date().toISOString(),
      items_evaluated: counters.items_evaluated,
      items_acted: counters.items_acted,
      items_queued: counters.items_queued,
      items_skipped: counters.items_skipped,
      alerts_sent: counters.alerts_sent,
      conditions,
    }));

    logger.info('runAltusHeartbeat: completed', { duration_ms: durationMs, ...counters });
    return counters;
  } catch (err) {
    logger.error('runAltusHeartbeat: error', { error: err.message });
    await pool.query(
      `INSERT INTO altus_heartbeat_log (run_at, duration_ms, error_message)
       VALUES (NOW(), $1, $2)`,
      [Date.now() - start, err.message],
    );
    return counters;
  }
}

// ---------------------------------------------------------------------------
// Action items schema init (called from altus-action-items.js)
// ---------------------------------------------------------------------------

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