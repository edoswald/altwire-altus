/**
 * Narrow governed writer for AltWire's shared Hal editorial state.
 *
 * This module deliberately owns only `hal:altwire:*`.  It is not a general
 * Hal-memory API: private, protected, and future namespaces must use their
 * own authenticated publisher rather than inheriting Altus's shared access.
 */

import { createHash } from 'node:crypto';
import pool from './altus-db.js';

export const ALTWIRE_HAL_MEMORY_PREFIX = 'hal:altwire:';
const ALTWIRE_KEY_SUFFIX_RX = /^[a-z0-9][a-z0-9:_-]*$/;

function serializeValue(value) {
  if (typeof value === 'string') return value;
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError('AltWire Hal memory values must be serializable');
  return serialized;
}

function digestValue(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeOptionalInteger(value, name) {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

function normalizeOptionalDigest(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) {
    throw new TypeError('expectedDigest must be a SHA-256 hex digest');
  }
  return value.toLowerCase();
}

function normalizeExpiresAt(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new TypeError('expiresAt must be a valid timestamp');
  return parsed.toISOString();
}

function normalizeConfidence(value) {
  if (value === undefined || value === null) return 1;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError('confidence must be a finite number between 0 and 1');
  }
  return value;
}

export function isAltwireHalMemoryKey(key) {
  return typeof key === 'string'
    && key.startsWith(ALTWIRE_HAL_MEMORY_PREFIX)
    && ALTWIRE_KEY_SUFFIX_RX.test(key.slice(ALTWIRE_HAL_MEMORY_PREFIX.length));
}

function normalizeRequest(input = {}) {
  const key = String(input.key ?? '');
  if (!isAltwireHalMemoryKey(key)) {
    throw Object.assign(new Error('Altus may publish only canonical hal:altwire:* shared memory keys'), {
      code: 'altwire_hal_memory_key_not_allowed',
    });
  }
  if (input.ifAbsent !== undefined && typeof input.ifAbsent !== 'boolean') {
    throw new TypeError('ifAbsent must be a boolean');
  }
  if (input.provenance !== undefined && (!input.provenance || typeof input.provenance !== 'object' || Array.isArray(input.provenance))) {
    throw new TypeError('provenance must be an object');
  }

  const serializedValue = serializeValue(input.value);
  const sourceId = typeof input.sourceId === 'string' && input.sourceId.trim()
    ? input.sourceId.trim()
    : 'altus:governed-hal-publisher';
  return {
    key,
    serializedValue,
    valueDigest: digestValue(serializedValue),
    memoryType: typeof input.memoryType === 'string' && input.memoryType.trim()
      ? input.memoryType.trim()
      : 'editorial_context',
    sourceId,
    provenance: {
      ...(input.provenance ?? {}),
      publisher: 'altus-governed-hal-publisher',
      source: 'altus',
      source_id: sourceId,
    },
    expectedVersion: normalizeOptionalInteger(input.expectedVersion, 'expectedVersion'),
    expectedDigest: normalizeOptionalDigest(input.expectedDigest),
    ifAbsent: input.ifAbsent === true,
    confidence: normalizeConfidence(input.confidence),
    expiresAt: normalizeExpiresAt(input.expiresAt),
  };
}

function normalizeRow(row) {
  if (!row) return null;
  return {
    agent: row.agent,
    key: row.key,
    value: row.value,
    tenantId: row.tenant_id ?? null,
    scope: row.scope ?? null,
    memoryType: row.memory_type ?? null,
    source: row.source ?? null,
    sourceId: row.source_id ?? null,
    provenance: row.provenance ?? null,
    valueDigest: row.value_digest ?? null,
    version: row.version ?? 0,
    confidence: row.confidence ?? null,
    expiresAt: row.expires_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

function snapshotMatches(request, row) {
  return (request.expectedVersion === null || request.expectedVersion === Number(row.version ?? 0))
    && (request.expectedDigest === null || request.expectedDigest === row.value_digest);
}

const ENVELOPE_COLUMNS = `
  agent, key, value, tenant_id, scope, memory_type, source, source_id,
  provenance, value_digest, version, confidence, expires_at, updated_at`;

/**
 * Publish one shared AltWire artifact using Hal's envelope contract.
 *
 * A transaction-scoped advisory lock protects the absent-row case as well as
 * existing rows.  That gives cron and interactive writers structured
 * `created`, `updated`, `exists`, or `stale` results instead of a race-prone
 * duplicate-key failure.
 */
export async function publishAltwireHalMemory(input = {}, context = {}) {
  const request = normalizeRequest(input);
  const ownsTransaction = !context.client;
  const client = context.client ?? await pool.connect();
  let inTransaction = false;
  try {
    if (ownsTransaction) {
      await client.query('BEGIN');
      inTransaction = true;
    }
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [JSON.stringify(['hal', request.key])],
    );
    const currentResult = await client.query(
      `SELECT ${ENVELOPE_COLUMNS} FROM agent_memory WHERE agent = $1 AND key = $2 FOR UPDATE`,
      ['hal', request.key],
    );
    const current = currentResult.rows[0] ?? null;

    if (!current && (request.expectedVersion !== null || request.expectedDigest !== null)) {
      if (ownsTransaction) {
        await client.query('ROLLBACK');
        inTransaction = false;
      }
      return { status: 'stale' };
    }
    if (current && (current.tenant_id ?? null) !== null) {
      if (ownsTransaction) {
        await client.query('ROLLBACK');
        inTransaction = false;
      }
      return { status: 'stale', reason: 'tenant_mismatch' };
    }
    if (current && request.ifAbsent) {
      if (ownsTransaction) {
        await client.query('COMMIT');
        inTransaction = false;
      }
      return { status: 'exists', row: normalizeRow(current) };
    }
    if (current && !snapshotMatches(request, current)) {
      if (ownsTransaction) {
        await client.query('ROLLBACK');
        inTransaction = false;
      }
      const row = normalizeRow(current);
      return { status: 'stale', row, priorVersion: row.version, priorDigest: row.valueDigest };
    }

    const params = [
      request.serializedValue,
      request.memoryType,
      request.sourceId,
      JSON.stringify(request.provenance),
      request.valueDigest,
      request.confidence,
      request.expiresAt,
    ];
    const result = current
      ? await client.query(
          `UPDATE agent_memory
              SET value = $1, tenant_id = NULL, scope = 'shared', memory_type = $2,
                  source = 'altus', source_id = $3, provenance = $4::jsonb,
                  value_digest = $5, version = COALESCE(version, 0) + 1,
                  confidence = $6, expires_at = $7, updated_at = NOW()
            WHERE agent = 'hal' AND key = $8
            RETURNING ${ENVELOPE_COLUMNS}`,
          [...params, request.key],
        )
      : await client.query(
          `INSERT INTO agent_memory (
             agent, key, value, tenant_id, scope, memory_type, source,
             source_id, provenance, value_digest, version, confidence, expires_at
           ) VALUES ('hal', $1, $2, NULL, 'shared', $3, 'altus', $4, $5::jsonb, $6, 1, $7, $8)
           RETURNING ${ENVELOPE_COLUMNS}`,
          [request.key, ...params],
        );
    if (ownsTransaction) {
      await client.query('COMMIT');
      inTransaction = false;
    }
    return { status: current ? 'updated' : 'created', row: normalizeRow(result.rows[0]) };
  } catch (error) {
    if (ownsTransaction && inTransaction) await client.query('ROLLBACK');
    throw error;
  } finally {
    if (ownsTransaction) client.release();
  }
}
