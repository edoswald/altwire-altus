import pool, { hasDbConfig } from '../lib/altus-db.js';
import { logger } from '../logger.js';

export async function initChatPresenceSchema() {
  if (!hasDbConfig()) {
    logger.warn('altus-chat-presence: database URL not set, skipping schema init');
    return;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS altus_chat_presence (
      id SERIAL PRIMARY KEY,
      client_id VARCHAR(255) NOT NULL,
      admin_id INTEGER,
      session_token_hash VARCHAR(64) NOT NULL,
      last_active_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (client_id, session_token_hash)
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_altus_chat_presence_active
      ON altus_chat_presence (client_id, last_active_at)
  `);

  logger.info('altus-chat-presence: schema ready');
}

export async function upsertChatPresence({ client_id, admin_id = null, session_token_hash } = {}) {
  if (!hasDbConfig()) {
    return { success: false, exit_reason: 'config_error' };
  }
  if (!client_id || !session_token_hash) {
    return { success: false, exit_reason: 'validation_error', message: 'client_id and session_token_hash are required' };
  }

  await pool.query(
    `INSERT INTO altus_chat_presence (client_id, admin_id, session_token_hash, last_active_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (client_id, session_token_hash)
     DO UPDATE SET admin_id = EXCLUDED.admin_id, last_active_at = NOW()`,
    [client_id, admin_id, session_token_hash],
  );

  return { success: true };
}

export async function isClientActiveInChat(clientId) {
  if (!hasDbConfig() || !clientId) {
    return false;
  }

  const windowMinutes = parseInt(process.env.CHAT_ACTIVE_WINDOW_MINUTES, 10) || 10;

  try {
    const { rows } = await pool.query(
      `SELECT id
         FROM altus_chat_presence
        WHERE client_id = $1
          AND last_active_at > NOW() - ($2 || ' minutes')::INTERVAL
        LIMIT 1`,
      [clientId, String(windowMinutes)],
    );
    return rows.length > 0;
  } catch (err) {
    logger.error('altus-chat-presence: active lookup failed', { error: err.message, clientId });
    return false;
  }
}

export async function listChatPresence({ client_id = null, active_only = true, limit = 20 } = {}) {
  if (!hasDbConfig()) {
    return { success: false, exit_reason: 'config_error' };
  }

  const resolvedLimit = Math.min(Math.max(Number(limit ?? 20), 1), 100);
  const conditions = [];
  const params = [];

  if (client_id) {
    params.push(client_id);
    conditions.push(`client_id = $${params.length}`);
  }

  if (active_only) {
    const windowMinutes = parseInt(process.env.CHAT_ACTIVE_WINDOW_MINUTES, 10) || 10;
    params.push(String(windowMinutes));
    conditions.push(`last_active_at > NOW() - ($${params.length} || ' minutes')::INTERVAL`);
  }

  params.push(resolvedLimit);

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT client_id, admin_id, session_token_hash, last_active_at
       FROM altus_chat_presence
       ${whereClause}
      ORDER BY last_active_at DESC
      LIMIT $${params.length}`,
    params,
  );

  return { success: true, presence: rows, count: rows.length };
}

export async function cleanupChatPresence() {
  if (!hasDbConfig()) {
    return { deleted: 0 };
  }

  const { rowCount } = await pool.query(
    `DELETE FROM altus_chat_presence
      WHERE last_active_at < NOW() - INTERVAL '24 hours'`,
  );

  return { deleted: rowCount };
}
