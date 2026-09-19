/**
 * handlers/altus-memory-scope.js
 *
 * Memory scope router for Altus — classifies keys as shared or admin-scoped.
 * Admin-scoped keys stored as altus:mem:{admin_id}:{key}.
 * Shared keys pass through untransformed.
 *
 * Adapted from cirrusly-nimbus/hal-memory-scope.js for AltWire editorial context.
 *
 * Exports:
 *   SHARED_PREFIXES
 *   classifyKey(key) → 'shared' | 'admin_scoped'
 *   transformKey(admin_id, key)
 *   stripPrefix(admin_id, key)
 *   scopedWriteMemory(admin_id, key, value)
 *   scopedReadMemory(admin_id, key)
 *   scopedDeleteMemory(admin_id, key)
 *   scopedReadAllMemory(admin_id)
 */

import { readAgentMemory, writeAgentMemory, deleteAgentMemory } from '../lib/altus-db.js';
import pool from '../lib/altus-db.js';
import { logger } from '../logger.js';
import { isAltwireHalMemoryKey, publishAltwireHalMemory } from '../lib/altus-hal-memory-publisher.js';

export const SHARED_PREFIXES = [
  'altus:soul',
  'altus:perch_agenda',
  'altus:story_opportunities:',
  'altus:news_alert:',
  'altus:heartbeat:',
  'hal:portable_context:',
  'hal:altwire:',
  'hal:soul',
  'hal:perch_agenda',
  'metrics:',
  'reflection:',
  'prediction:',
];

export function classifyKey(key) {
  for (const prefix of SHARED_PREFIXES) {
    if (key === prefix || key.startsWith(prefix)) return 'shared';
  }
  return 'admin_scoped';
}

export function transformKey(admin_id, key) {
  return `altus:mem:${admin_id}:${key}`;
}

export function stripPrefix(admin_id, key) {
  const pfx = `altus:mem:${admin_id}:`;
  if (key.startsWith(pfx)) return key.slice(pfx.length);
  return key;
}

export async function scopedWriteMemory(admin_id, key, value) {
  if (isAltwireHalMemoryKey(key)) {
    return publishAltwireHalMemory({
      key,
      value,
      memoryType: 'editorial_context',
      sourceId: 'altus-memory-scope',
    });
  }
  if (key.startsWith('hal:')) return { success: false, exit_reason: 'hal_key_not_publishable' };
  const scope = classifyKey(key);
  if (scope === 'shared') return writeAgentMemory('altus', key, value);
  if (!admin_id) return { success: false, exit_reason: 'missing_admin_id' };
  return writeAgentMemory('altus', transformKey(admin_id, key), value);
}

export async function scopedReadMemory(admin_id, key) {
  if (isAltwireHalMemoryKey(key) || key.startsWith('hal:')) {
    return readAgentMemory('hal', key);
  }
  const scope = classifyKey(key);
  if (scope === 'shared') {
    const canonical = await readAgentMemory('altus', key);
    return canonical.success ? canonical : readAgentMemory('hal', key);
  }
  if (!admin_id) return { success: false, exit_reason: 'missing_admin_id' };
  const physicalKey = transformKey(admin_id, key);
  const canonical = await readAgentMemory('altus', physicalKey);
  return canonical.success ? canonical : readAgentMemory('hal', physicalKey);
}

export async function scopedDeleteMemory(admin_id, key) {
  if (isAltwireHalMemoryKey(key) || key.startsWith('hal:')) return { success: false, exit_reason: 'hal_key_not_deletable' };
  const scope = classifyKey(key);
  if (scope === 'shared') return deleteAgentMemory('altus', key);
  if (!admin_id) return { success: false, exit_reason: 'missing_admin_id' };
  return deleteAgentMemory('altus', transformKey(admin_id, key));
}

export async function scopedReadAllMemory(admin_id) {
  const keys = [];

  const likeClauses = SHARED_PREFIXES.map((_, i) => `key LIKE $${i + 2}`);
  const likeParams = SHARED_PREFIXES.map(p => p + '%');

  const sharedSql = `SELECT key, value, updated_at FROM (
    SELECT DISTINCT ON (key) key, value, updated_at, agent
      FROM agent_memory
     WHERE agent IN ('hal', 'altus') AND (${likeClauses.join(' OR ')})
     ORDER BY key, (agent = 'altus') DESC, updated_at DESC
  ) shared_memory ORDER BY updated_at DESC`;
  const { rows: sharedRows } = await pool.query(sharedSql, ['hal', ...likeParams]);
  for (const row of sharedRows) {
    keys.push({ key: row.key, value: row.value, updated_at: row.updated_at, scope: 'shared' });
  }

  if (admin_id) {
    const scopedPattern = `altus:mem:${admin_id}:%`;
    const { rows: scopedRows } = await pool.query(
      `SELECT key, value, updated_at FROM agent_memory WHERE agent = 'altus' AND key LIKE $1 ORDER BY updated_at DESC`,
      [scopedPattern],
    );
    for (const row of scopedRows) {
      keys.push({ key: stripPrefix(admin_id, row.key), value: row.value, updated_at: row.updated_at, scope: 'admin_scoped' });
    }
  }

  return { success: true, keys };
}
