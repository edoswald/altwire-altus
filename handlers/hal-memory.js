/**
 * handlers/hal-memory.js — Agent memory tools for Altus MCP server.
 *
 * Provides memory read/write/list/delete tools scoped to the Hal agent.
 * Used to access hal:soul:altwire, hal:altwire:editorial_context, and other
 * Hal memory keys from within the MCP tool framework.
 *
 * Note: This does not include soul evolution — that requires the Claude Haiku
 * integration and is handled separately. This is just memory CRUD.
 *
 * Soft-delete: writeAgentMemory undeletes any soft-deleted row.
 * deleteMemory sets deleted_at (soft delete) — row is retained but hidden
 * until explicitly read or restored.
 */

import { readAgentMemory } from '../lib/altus-db.js';
import { isAltwireHalMemoryKey, publishAltwireHalMemory } from '../lib/altus-hal-memory-publisher.js';

/**
 * Read a single memory entry.
 * @param {string} key
 * @returns {Promise<{success: boolean, value: string}|{success: false, exit_reason: string}>}
 */
export async function readMemory(key) {
  return readAgentMemory('hal', key);
}

/**
 * Write a memory entry (undeletes if previously soft-deleted).
 * @param {string} key
 * @param {string} value
 * @returns {Promise<{success: boolean, key: string}>}
 */
export async function writeMemory(key, value) {
  if (!isAltwireHalMemoryKey(key)) {
    return {
      success: false,
      exit_reason: 'altwire_hal_memory_key_required',
      message: 'Altus may publish only canonical hal:altwire:* shared memory keys.',
    };
  }
  const result = await publishAltwireHalMemory({
    key,
    value,
    memoryType: 'editorial_context',
    sourceId: 'altus-hal-memory-tool',
  });
  return { success: result.status === 'created' || result.status === 'updated', ...result };
}

/**
 * List all memory entries for the Hal agent, newest first.
 * Soft-deleted rows (deleted_at IS NOT NULL) are excluded.
 * @returns {Promise<Array<{key: string, value: string, updated_at: string}>>}
 */
export async function listMemory() {
  const { pool } = await import('../lib/altus-db.js');
  const { rows } = await pool.query(
    `SELECT key, value, updated_at FROM agent_memory
     WHERE agent = 'hal' AND deleted_at IS NULL
     ORDER BY updated_at DESC`
  );
  return rows;
}

/**
 * Altus intentionally does not delete shared Hal state. Callers can publish a
 * governed replacement, while retention remains centrally observable.
 * @param {string} key
 * @returns {{ success: boolean, deleted: boolean, reason?: string }}
 */
export async function deleteMemory(key) {
  if (!isAltwireHalMemoryKey(key)) {
    return { success: false, deleted: false, reason: 'Altus may not delete this Hal memory key.' };
  }
  return { success: false, deleted: false, reason: 'Shared AltWire Hal memory is retained; use a governed replacement instead.' };
}
