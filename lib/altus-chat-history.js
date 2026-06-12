/**
 * lib/altus-chat-history.js — Persistent chat session storage for the Hal
 * web UI in altwire mode.
 *
 * Mirrors Nimbus's hal-chat-history.js so the shared Hal chat UI can save,
 * list, restore, and delete sessions against Altus. Response shapes match
 * Nimbus exactly: { sessions: [...] }, { session: {...} }, { success: true }.
 *
 * Exports: initChatHistorySchema, saveSession, listSessions, getSession, deleteSession
 */

import pool, { hasDbConfig } from './altus-db.js';
import { logger } from '../logger.js';

export async function initChatHistorySchema() {
  if (!hasDbConfig()) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS altus_chat_sessions (
        id          TEXT PRIMARY KEY,
        title       TEXT NOT NULL DEFAULT 'Untitled',
        admin_name  TEXT,
        messages    JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  } catch (err) {
    logger.warn('initChatHistorySchema: failed', { error: err.message });
  }
}

/**
 * Save or update a chat session.
 * @param {string} id - Client-generated session ID
 * @param {string} title - First user message (truncated)
 * @param {Array} messages - Full message array [{role, content, timestamp}]
 * @param {string|null} adminName - Authenticated admin who owns the session
 */
export async function saveSession(id, title, messages, adminName = null) {
  if (!hasDbConfig()) return { error: 'database_not_configured' };
  try {
    await pool.query(
      `INSERT INTO altus_chat_sessions (id, title, admin_name, messages, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, NOW())
       ON CONFLICT (id) DO UPDATE
         SET title = EXCLUDED.title,
             admin_name = EXCLUDED.admin_name,
             messages = EXCLUDED.messages,
             updated_at = NOW()`,
      [id, title, adminName, JSON.stringify(messages)],
    );
    return { success: true };
  } catch (err) {
    logger.error('altus-chat-history saveSession: failed', { error: err.message });
    return { error: err.message };
  }
}

/**
 * List recent sessions (most recent first).
 * Returns id, title, created_at, updated_at, message_count.
 */
export async function listSessions(limit = 50) {
  if (!hasDbConfig()) return { error: 'database_not_configured' };
  try {
    const { rows } = await pool.query(
      `SELECT id, title, created_at, updated_at, jsonb_array_length(messages) AS message_count
       FROM altus_chat_sessions
       ORDER BY updated_at DESC
       LIMIT $1`,
      [limit],
    );
    return { sessions: rows };
  } catch (err) {
    logger.error('altus-chat-history listSessions: failed', { error: err.message });
    return { error: err.message };
  }
}

/**
 * Get a single session with full messages.
 */
export async function getSession(id) {
  if (!hasDbConfig()) return { error: 'database_not_configured' };
  try {
    const { rows } = await pool.query(
      `SELECT id, title, messages, created_at, updated_at FROM altus_chat_sessions WHERE id = $1`,
      [id],
    );
    if (rows.length === 0) return { error: 'not_found' };
    return { session: rows[0] };
  } catch (err) {
    logger.error('altus-chat-history getSession: failed', { error: err.message });
    return { error: err.message };
  }
}

/**
 * Delete a session.
 */
export async function deleteSession(id) {
  if (!hasDbConfig()) return { error: 'database_not_configured' };
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM altus_chat_sessions WHERE id = $1`,
      [id],
    );
    return { success: true, deleted: rowCount > 0 };
  } catch (err) {
    logger.error('altus-chat-history deleteSession: failed', { error: err.message });
    return { error: err.message };
  }
}
