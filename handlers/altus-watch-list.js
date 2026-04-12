/**
 * altus-watch-list.js
 *
 * Watch list management for the Altus news monitor.
 * Maintains a list of artists and topics that the news monitor cron
 * cross-references against GSC News data.
 */

import pool from '../lib/altus-db.js';
import { logger } from '../logger.js';

// ---------------------------------------------------------------------------
// Schema initialization
// ---------------------------------------------------------------------------

/**
 * Creates the altus_watch_list table and supporting indexes.
 * Safe to run on every deploy (all DDL uses IF NOT EXISTS).
 */
export async function initWatchListSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS altus_watch_list (
      id        SERIAL PRIMARY KEY,
      name      TEXT NOT NULL UNIQUE,
      active    BOOLEAN NOT NULL DEFAULT TRUE,
      added_at  TIMESTAMPTZ DEFAULT NOW(),
      notes     TEXT
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_altus_watch_list_active ON altus_watch_list (active)`);
  logger.info('Watch list schema initialized');
}

// ---------------------------------------------------------------------------
// Add watch subject
// ---------------------------------------------------------------------------

/**
 * Adds a new subject to the watch list.
 * Performs a case-insensitive duplicate check before inserting.
 * Name is stored exactly as provided (case-preserved).
 *
 * @param {object} params
 * @param {string} params.name  - Artist or topic name
 * @param {string} [params.notes] - Optional context
 * @returns {{ subject: object } | { error: string, existing_id: number, existing_name: string }}
 */
export async function addWatchSubject({ name, notes }) {
  // Pre-insert case-insensitive duplicate check
  const { rows: existing } = await pool.query(
    `SELECT id, name FROM altus_watch_list WHERE LOWER(name) = LOWER($1)`,
    [name],
  );

  if (existing.length > 0) {
    return { error: 'duplicate', existing_id: existing[0].id, existing_name: existing[0].name };
  }

  const { rows } = await pool.query(
    `INSERT INTO altus_watch_list (name, notes) VALUES ($1, $2) RETURNING *`,
    [name, notes || null],
  );

  return { subject: rows[0] };
}

// ---------------------------------------------------------------------------
// Remove watch subject
// ---------------------------------------------------------------------------

/**
 * Soft-deletes a watch subject by setting active = false.
 * Accepts either an id (exact match) or a name (case-insensitive ILIKE match).
 * At least one of id or name must be provided.
 *
 * @param {object} params
 * @param {number} [params.id]   - Subject ID (exact match)
 * @param {string} [params.name] - Subject name (case-insensitive ILIKE match)
 * @returns {{ deactivated_count: number, subjects: object[] } | { error: string }}
 */
export async function removeWatchSubject({ id, name } = {}) {
  if (!id && !name) {
    return { error: 'Either id or name must be provided' };
  }

  let result;

  if (id) {
    result = await pool.query(
      `UPDATE altus_watch_list SET active = false WHERE id = $1 AND active = true RETURNING *`,
      [id],
    );
  } else {
    result = await pool.query(
      `UPDATE altus_watch_list SET active = false WHERE name ILIKE $1 AND active = true RETURNING *`,
      [name],
    );
  }

  const { rows } = result;

  if (rows.length === 0) {
    return { deactivated_count: 0, subjects: [], note: 'No matching active subjects found' };
  }

  return { deactivated_count: rows.length, subjects: rows };
}

// ---------------------------------------------------------------------------
// List watch subjects
// ---------------------------------------------------------------------------

/**
 * Lists watch subjects from the watch list.
 * By default returns only active subjects. When include_inactive is true,
 * returns all subjects (active first, then inactive, newest first within each group).
 *
 * @param {object} [params]
 * @param {boolean} [params.include_inactive=false] - Include deactivated subjects
 * @returns {{ subjects: object[], total: number, active_count: number }}
 */
export async function listWatchSubjects({ include_inactive } = {}) {
  let query;

  if (include_inactive) {
    query = `SELECT * FROM altus_watch_list ORDER BY active DESC, added_at DESC`;
  } else {
    query = `SELECT * FROM altus_watch_list WHERE active = true ORDER BY added_at DESC`;
  }

  const { rows } = await pool.query(query);

  const active_count = rows.filter((r) => r.active === true).length;

  return { subjects: rows, total: rows.length, active_count };
}
