/**
 * Strict private writer for the one Altus-to-Hal reflection signal we retain:
 * completed editorial action-item wins. This is intentionally not a general
 * admin-memory API. The configured primary admin and an authoritative tenant
 * binding are both required before anything is written.
 */

import { createHash } from 'node:crypto';
import pool from './altus-db.js';

const REFLECTION_WINS_KEY = 'reflection:wins';

function primaryAdminId(raw = process.env.HAL_PRIMARY_ADMIN_ID) {
  const id = String(raw ?? '').trim();
  return /^[1-9]\d*$/.test(id) ? id : null;
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function parseWins(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Append one completed action item to the configured primary admin's private
 * reflection record. A legacy global record is read only as a one-way fallback
 * when the canonical record is first created; it is never modified in place.
 */
export async function appendPrimaryReflectionWin({ winText, maxItems = 25 } = {}) {
  if (typeof winText !== 'string' || !winText.trim()) {
    return { success: false, exit_reason: 'invalid_win' };
  }
  if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 100) {
    return { success: false, exit_reason: 'invalid_max_items' };
  }
  const adminId = primaryAdminId();
  if (!adminId) return { success: false, exit_reason: 'primary_admin_unconfigured' };

  const key = `hal:mem:${adminId}:${REFLECTION_WINS_KEY}`;
  const client = await pool.connect();
  let inTransaction = false;
  try {
    await client.query('BEGIN');
    inTransaction = true;
    const binding = await client.query(
      `SELECT tenant_id
         FROM hal_admin_tenant_bindings
        WHERE admin_id = $1 AND active = TRUE
        LIMIT 1`,
      [adminId],
    );
    const tenantId = binding.rows[0]?.tenant_id ?? null;
    if (!tenantId) {
      await client.query('ROLLBACK');
      inTransaction = false;
      return { success: false, exit_reason: 'primary_tenant_unbound' };
    }
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [JSON.stringify(['hal', key])],
    );
    const currentResult = await client.query(
      `SELECT value, tenant_id, version
         FROM agent_memory
        WHERE agent = 'hal' AND key = $1
        FOR UPDATE`,
      [key],
    );
    const current = currentResult.rows[0] ?? null;
    if (current && current.tenant_id !== tenantId) {
      await client.query('ROLLBACK');
      inTransaction = false;
      return { success: false, exit_reason: 'tenant_mismatch' };
    }

    let priorWins = current ? parseWins(current.value) : [];
    if (!current) {
      const legacy = await client.query(
        `SELECT value FROM agent_memory WHERE agent = 'hal' AND key = $1`,
        [REFLECTION_WINS_KEY],
      );
      priorWins = parseWins(legacy.rows[0]?.value ?? '[]');
    }
    const value = JSON.stringify([...priorWins, winText.trim()].slice(-maxItems));
    const result = current
      ? await client.query(
          `UPDATE agent_memory
              SET value = $1, tenant_id = $2, scope = 'admin', memory_type = 'reflection',
                  source = 'altus', source_id = 'altus-action-items',
                  provenance = $3::jsonb, value_digest = $4,
                  version = COALESCE(version, 0) + 1, updated_at = NOW()
            WHERE agent = 'hal' AND key = $5
            RETURNING version, updated_at`,
          [value, tenantId, JSON.stringify({ source: 'altus', source_id: 'altus-action-items', publisher: 'altus-primary-reflection-wins' }), digest(value), key],
        )
      : await client.query(
          `INSERT INTO agent_memory (
             agent, key, value, tenant_id, scope, memory_type, source, source_id,
             provenance, value_digest, version
           ) VALUES ('hal', $1, $2, $3, 'admin', 'reflection', 'altus', 'altus-action-items', $4::jsonb, $5, 1)
           RETURNING version, updated_at`,
          [key, value, tenantId, JSON.stringify({ source: 'altus', source_id: 'altus-action-items', publisher: 'altus-primary-reflection-wins' }), digest(value)],
        );
    await client.query('COMMIT');
    inTransaction = false;
    return {
      success: true,
      status: current ? 'updated' : 'created',
      key,
      version: result.rows[0]?.version ?? null,
      updated_at: result.rows[0]?.updated_at ?? null,
    };
  } catch (error) {
    if (inTransaction) await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
