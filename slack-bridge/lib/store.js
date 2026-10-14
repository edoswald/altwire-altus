/**
 * Postgres persistence for the bridge. Tables are prefixed `bridge_` so they
 * can share Altus's database without colliding.
 */

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS bridge_sessions (
  session_key   TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  slack_user_id TEXT NOT NULL,
  vault_ids     TEXT[] NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bridge_user_vaults (
  slack_user_id TEXT PRIMARY KEY,
  vault_id      TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bridge_oauth_states (
  state          TEXT PRIMARY KEY,
  slack_user_id  TEXT NOT NULL,
  dm_channel     TEXT NOT NULL,
  server_label   TEXT NOT NULL,
  server_url     TEXT NOT NULL,
  flow           JSONB NOT NULL,
  expires_at     TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS bridge_seen_events (
  event_id   TEXT PRIMARY KEY,
  seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

export class Store {
  constructor(pool) {
    this.pool = pool;
  }

  async init() {
    await this.pool.query(SCHEMA_SQL);
  }

  /** Record a Slack event id; returns false if it was already seen (Slack retries). */
  async markEventSeen(eventId) {
    const { rowCount } = await this.pool.query(
      'INSERT INTO bridge_seen_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING',
      [eventId],
    );
    return rowCount === 1;
  }

  async pruneSeenEvents() {
    await this.pool.query(`DELETE FROM bridge_seen_events WHERE seen_at < NOW() - INTERVAL '1 day'`);
    await this.pool.query('DELETE FROM bridge_oauth_states WHERE expires_at < NOW()');
  }

  /**
   * The session for a key. A rolling DM session older than `maxIdleMinutes`
   * is treated as expired, so a new conversation starts fresh.
   */
  async getSession(sessionKey, { maxIdleMinutes = null } = {}) {
    const { rows } = await this.pool.query(
      'SELECT session_id, slack_user_id, vault_ids, updated_at FROM bridge_sessions WHERE session_key = $1',
      [sessionKey],
    );
    const row = rows[0];
    if (!row) return null;
    if (maxIdleMinutes != null && Date.now() - new Date(row.updated_at).getTime() > maxIdleMinutes * 60_000) return null;
    return { sessionId: row.session_id, slackUserId: row.slack_user_id, vaultIds: row.vault_ids };
  }

  async saveSession(sessionKey, { sessionId, slackUserId, vaultIds }) {
    await this.pool.query(
      `INSERT INTO bridge_sessions (session_key, session_id, slack_user_id, vault_ids)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (session_key) DO UPDATE
         SET session_id = EXCLUDED.session_id, slack_user_id = EXCLUDED.slack_user_id,
             vault_ids = EXCLUDED.vault_ids, updated_at = NOW()`,
      [sessionKey, sessionId, slackUserId, vaultIds],
    );
  }

  async touchSession(sessionKey) {
    await this.pool.query('UPDATE bridge_sessions SET updated_at = NOW() WHERE session_key = $1', [sessionKey]);
  }

  async forgetSession(sessionKey) {
    await this.pool.query('DELETE FROM bridge_sessions WHERE session_key = $1', [sessionKey]);
  }

  /** Forget a person's DM sessions (keys start with their DM channel, which begins with D). */
  async forgetDmSessions(slackUserId) {
    await this.pool.query(`DELETE FROM bridge_sessions WHERE slack_user_id = $1 AND session_key LIKE 'D%'`, [slackUserId]);
  }

  async getUserVault(slackUserId) {
    const { rows } = await this.pool.query('SELECT vault_id FROM bridge_user_vaults WHERE slack_user_id = $1', [slackUserId]);
    return rows[0]?.vault_id ?? null;
  }

  async saveUserVault(slackUserId, vaultId) {
    await this.pool.query(
      `INSERT INTO bridge_user_vaults (slack_user_id, vault_id) VALUES ($1, $2)
       ON CONFLICT (slack_user_id) DO UPDATE SET vault_id = EXCLUDED.vault_id`,
      [slackUserId, vaultId],
    );
  }

  async saveOAuthState(state, { slackUserId, dmChannel, serverLabel, serverUrl, flow, ttlMinutes = 10 }) {
    await this.pool.query(
      `INSERT INTO bridge_oauth_states (state, slack_user_id, dm_channel, server_label, server_url, flow, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW() + make_interval(mins => $7))`,
      [state, slackUserId, dmChannel, serverLabel, serverUrl, JSON.stringify(flow), ttlMinutes],
    );
  }

  /** Fetch and delete a pending OAuth state in one step, so a link works once. */
  async takeOAuthState(state) {
    const { rows } = await this.pool.query(
      `DELETE FROM bridge_oauth_states WHERE state = $1 AND expires_at > NOW()
       RETURNING slack_user_id, dm_channel, server_label, server_url, flow`,
      [state],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      slackUserId: row.slack_user_id,
      dmChannel: row.dm_channel,
      serverLabel: row.server_label,
      serverUrl: row.server_url,
      flow: typeof row.flow === 'string' ? JSON.parse(row.flow) : row.flow,
    };
  }
}
