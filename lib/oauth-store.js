/**
 * OAuth Token Store
 *
 * Persists OAuth authorization codes, access tokens, and refresh tokens
 * in Railway PostgreSQL so they survive deploys and restarts.
 *
 * Follows the same module pattern as call-logger.js and link-shortener.js.
 *
 * Exports:
 *   initOAuthSchema()                    → creates tables + indexes if absent
 *   storeAuthCode(code, data)            → void
 *   getAuthCode(code)                    → data | null
 *   deleteAuthCode(code)                 → void
 *   storeAccessToken(token, data)        → void
 *   getAccessToken(token)                → data | null (null if expired)
 *   deleteAccessToken(token)             → void
 *   storeRefreshToken(token, data)       → void
 *   getRefreshToken(token)               → data | null
 *   deleteRefreshToken(token)            → void
 */

import pool from './altus-db.js';
import { logger } from '../logger.js';

/**
 * Create OAuth tables and indexes if they don't already exist.
 * Idempotent — safe to call on every startup.
 */
export async function initOAuthSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS oauth_auth_codes (
      code                  VARCHAR(255) PRIMARY KEY,
      client_id             VARCHAR(255) NOT NULL,
      redirect_uri          TEXT NOT NULL,
      scope                 VARCHAR(255) NOT NULL DEFAULT 'read',
      state                 TEXT,
      code_challenge        TEXT,
      code_challenge_method VARCHAR(10),
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at            TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS oauth_access_tokens (
      token      VARCHAR(255) PRIMARY KEY,
      client_id  VARCHAR(255) NOT NULL,
      scope      VARCHAR(255) NOT NULL DEFAULT 'read',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_oauth_access_tokens_expires
      ON oauth_access_tokens(expires_at);

    CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
      token      VARCHAR(255) PRIMARY KEY,
      client_id  VARCHAR(255) NOT NULL,
      scope      VARCHAR(255),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE oauth_refresh_tokens
      ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
    -- NOTE: the expires_at backfill was removed after the initial migration.

    CREATE TABLE IF NOT EXISTS oauth_clients (
      client_id     VARCHAR(255) PRIMARY KEY,
      redirect_uris TEXT NOT NULL,
      client_name   VARCHAR(255),
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

// ---------------------------------------------------------------------------
// Dynamically registered clients (RFC 7591 Dynamic Client Registration)
//
// Persisted in Postgres rather than memory so that a client which registered
// before a deploy/restart — or against a different replica — is still known at
// /authorize and /oauth/token time. Claude reuses its registered client_id
// across sessions, so an in-memory registry breaks on the next restart.
// ---------------------------------------------------------------------------

export async function storeClient(clientId, data) {
  await pool.query(
    `INSERT INTO oauth_clients (client_id, redirect_uris, client_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (client_id) DO NOTHING`,
    [clientId, JSON.stringify(data.redirectUris || []), data.clientName ?? null],
  );
}

export async function getClient(clientId) {
  const result = await pool.query(
    'SELECT redirect_uris, client_name FROM oauth_clients WHERE client_id = $1',
    [clientId],
  );
  if (!result.rows[0]) return null;
  const row = result.rows[0];
  let redirectUris = [];
  try {
    redirectUris = Array.isArray(row.redirect_uris) ? row.redirect_uris : JSON.parse(row.redirect_uris);
  } catch {
    redirectUris = [];
  }
  return { redirectUris, clientName: row.client_name };
}

// ---------------------------------------------------------------------------
// Authorization codes (10-minute TTL)
// ---------------------------------------------------------------------------

/**
 * @param {string} code
 * @param {{ clientId, redirectUri, scope, state, codeChallenge, codeChallengeMethod }} data
 */
export async function storeAuthCode(code, data) {
  await pool.query(
    `INSERT INTO oauth_auth_codes
       (code, client_id, redirect_uri, scope, state, code_challenge, code_challenge_method, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() + INTERVAL '10 minutes')
     ON CONFLICT (code) DO NOTHING`,
    [
      code,
      data.clientId,
      data.redirectUri,
      data.scope || 'read',
      data.state ?? null,
      data.codeChallenge ?? null,
      data.codeChallengeMethod ?? null,
    ],
  );
}

/**
 * Returns the auth code data, or null if not found or expired.
 * DELETES the code atomically to prevent replay attacks.
 *
 * @param {string} code
 * @returns {Promise<object|null>}
 */
export async function getAuthCode(code) {
  const result = await pool.query(
    `DELETE FROM oauth_auth_codes
      WHERE code = $1 AND expires_at > NOW()
      RETURNING client_id, redirect_uri, scope, state, code_challenge, code_challenge_method`,
    [code],
  );
  if (!result.rows[0]) return null;
  const row = result.rows[0];
  return {
    clientId:            row.client_id,
    redirectUri:         row.redirect_uri,
    scope:               row.scope,
    state:               row.state,
    codeChallenge:       row.code_challenge,
    codeChallengeMethod: row.code_challenge_method,
  };
}

/** @param {string} code */
export async function deleteAuthCode(code) {
  // No-op: deletion is now atomic within getAuthCode. Kept for API compatibility.
  await pool.query('DELETE FROM oauth_auth_codes WHERE code = $1', [code]);
}

// ---------------------------------------------------------------------------
// Access tokens (1-hour TTL)
// ---------------------------------------------------------------------------

/**
 * @param {string} token
 * @param {{ clientId, scope }} data
 */
export async function storeAccessToken(token, data) {
  await pool.query(
    `INSERT INTO oauth_access_tokens (token, client_id, scope, expires_at)
     VALUES ($1, $2, $3, NOW() + INTERVAL '1 hour')
     ON CONFLICT (token) DO NOTHING`,
    [token, data.clientId, data.scope || 'read'],
  );
}

/**
 * Returns token data, or null if not found or expired.
 * Lazily deletes expired rows.
 *
 * @param {string} token
 * @returns {Promise<object|null>}
 */
export async function getAccessToken(token) {
  const result = await pool.query(
    `SELECT client_id, scope, expires_at
     FROM oauth_access_tokens
     WHERE token = $1 AND expires_at > NOW()`,
    [token],
  );
  if (!result.rows[0]) return null;
  const row = result.rows[0];
  return { clientId: row.client_id, scope: row.scope };
}

/** @param {string} token */
export async function deleteAccessToken(token) {
  await pool.query('DELETE FROM oauth_access_tokens WHERE token = $1', [token]);
}

// ---------------------------------------------------------------------------
// Refresh tokens (30-day expiry)
// ---------------------------------------------------------------------------

/**
 * @param {string} token
 * @param {{ clientId, scope? }} data
 */
export async function storeRefreshToken(token, data) {
  await pool.query(
    `INSERT INTO oauth_refresh_tokens (token, client_id, scope, expires_at)
     VALUES ($1, $2, $3, NOW() + INTERVAL '30 days')
     ON CONFLICT (token) DO NOTHING`,
    [token, data.clientId, data.scope ?? null],
  );
}

/**
 * Returns token data, or null if not found or expired.
 * Lazily deletes expired rows.
 *
 * @param {string} token
 * @returns {Promise<object|null>}
 */
export async function getRefreshToken(token) {
  const result = await pool.query(
    'SELECT client_id, scope, expires_at FROM oauth_refresh_tokens WHERE token = $1',
    [token],
  );
  if (!result.rows[0]) return null;
  const row = result.rows[0];
  if (row.expires_at && new Date(row.expires_at) <= new Date()) {
    await pool.query('DELETE FROM oauth_refresh_tokens WHERE token = $1', [token]).catch(() => {});
    return null;
  }
  return { clientId: row.client_id, scope: row.scope };
}

/** @param {string} token */
export async function deleteRefreshToken(token) {
  await pool.query('DELETE FROM oauth_refresh_tokens WHERE token = $1', [token]);
}