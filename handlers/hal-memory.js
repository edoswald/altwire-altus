/**
 * handlers/hal-memory.js — Agent memory tools for Altus MCP server.
 *
 * Provides memory read/write/list/delete tools scoped to the Hal agent.
 * Used to access hal:soul:altwire, hal:altwire:editorial_context, and other
 * Hal memory keys from within the MCP tool framework.
 *
 * Note: This does not include soul evolution — that requires the Claude Haiku
 * integration and is handled separately. This is just memory CRUD.
 */

import { readAgentMemory, writeAgentMemory } from '../lib/altus-db.js';

/**
 * Read a single memory entry.
 * @param {string} key
 * @returns {Promise<{success: boolean, value: string}|{success: false, exit_reason: string}>}
 */
export async function readMemory(key) {
  return readAgentMemory('hal', key);
}

/**
 * Write a memory entry.
 * @param {string} key
 * @param {string} value
 * @returns {Promise<{success: boolean, key: string}>}
 */
export async function writeMemory(key, value) {
  return writeAgentMemory('hal', key, value);
}

/**
 * List all memory entries for the Hal agent, newest first.
 * @returns {Promise<Array<{key: string, value: string, updated_at: string}>>}
 */
export async function listMemory() {
  const { pool } = await import('../lib/altus-db.js');
  const { rows } = await pool.query(
    `SELECT key, value, updated_at FROM agent_memory WHERE agent = 'hal' ORDER BY updated_at DESC`
  );
  return rows;
}

/**
 * Delete a memory entry (soft delete not implemented — direct delete).
 * Protected keys (hal:soul*, hal:onboarding_state:*) cannot be deleted.
 * @param {string} key
 * @returns {{ success: boolean, deleted: boolean, reason?: string }}
 */
export async function deleteMemory(key) {
  if (key.startsWith('hal:soul') || key.startsWith('hal:onboarding_state:')) {
    return { success: true, deleted: false, reason: 'Protected key — cannot delete.' };
  }
  const { pool } = await import('../lib/altus-db.js');
  const result = await pool.query(
    `DELETE FROM agent_memory WHERE agent = 'hal' AND key = $1`,
    [key]
  );
  return { success: true, deleted: result.rowCount > 0 };
}