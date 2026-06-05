import pool, { hasDbConfig } from '../lib/altus-db.js';
import { logger } from '../logger.js';

export const WHITELISTED_PREFIXES = [
  'reflection:',
  'hal:research:',
  'metrics:',
  'hal:digest_template',
  'hal:altwire:',
];

export const EXCLUDED_PREFIXES = [
  'hal:soul',
  'hal:location',
  'hal:onboarding_',
  'hal:service_registry',
  'hal:business_goals',
  'hal:mem:',
  'contact_',
  'ben:',
  'hal:altwire:analytics:',
  'hal:altwire:gsc:',
  'hal:altwire:traffic_summary',
  'hal:altwire:top_articles',
  'hal:altwire:site_search_keywords',
];

export function isAllowedDocumentKey(key) {
  for (const prefix of EXCLUDED_PREFIXES) {
    if (key.startsWith(prefix)) return false;
  }
  for (const prefix of WHITELISTED_PREFIXES) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
}

export function deriveDocumentLabel(key) {
  let matchedPrefix = '';
  for (const prefix of WHITELISTED_PREFIXES) {
    if (key.startsWith(prefix)) {
      matchedPrefix = prefix;
      break;
    }
  }

  const suffix = key.slice(matchedPrefix.length);
  const labelSource = suffix || matchedPrefix;

  return labelSource
    .replace(/[:_-]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

export function computeWordCount(value) {
  return String(value || '').trim().split(/\s+/).filter(Boolean).length;
}

function getPrefixType(key) {
  if (key.startsWith('reflection:')) return 'Reflection';
  if (key.startsWith('hal:research:')) return 'Research';
  if (key.startsWith('metrics:')) return 'Metrics';
  if (key.startsWith('hal:digest_template')) return 'Digest';
  if (key.startsWith('hal:altwire:')) return 'Workspace';
  return 'Unknown';
}

export async function listDocuments({ limit = 50 } = {}) {
  if (!hasDbConfig()) {
    return { error: 'database_not_configured' };
  }

  const likePatterns = WHITELISTED_PREFIXES.map((prefix) => `${prefix}%`);
  const resolvedLimit = Math.min(Math.max(Number(limit ?? 50), 1), 200);

  const { rows } = await pool.query(
    `SELECT key, value, updated_at
       FROM agent_memory
      WHERE agent = 'hal'
        AND key LIKE ANY($1::text[])
      ORDER BY updated_at DESC
      LIMIT $2`,
    [likePatterns, resolvedLimit],
  );

  return rows
    .filter((row) => isAllowedDocumentKey(row.key))
    .map((row) => ({
      key: row.key,
      label: deriveDocumentLabel(row.key),
      prefix_type: getPrefixType(row.key),
      updated_at: row.updated_at,
      word_count: computeWordCount(row.value),
      preview: String(row.value || '').slice(0, 200),
    }));
}

export async function getDocument(key) {
  if (!hasDbConfig()) {
    return null;
  }
  if (!isAllowedDocumentKey(key)) {
    return { success: false, exit_reason: 'validation_error', message: 'key is not exposed through altus documents' };
  }

  const { rows } = await pool.query(
    `SELECT key, value, updated_at
       FROM agent_memory
      WHERE agent = 'hal' AND key = $1`,
    [key],
  );

  if (rows.length === 0) return null;

  const row = rows[0];
  return {
    key: row.key,
    value: row.value || '',
    label: deriveDocumentLabel(row.key),
    prefix_type: getPrefixType(row.key),
    updated_at: row.updated_at,
    word_count: computeWordCount(row.value),
  };
}

export async function saveDocument(key, value) {
  if (!hasDbConfig()) {
    return { error: 'database_not_configured' };
  }
  if (!isAllowedDocumentKey(key)) {
    return { success: false, exit_reason: 'validation_error', message: 'key is not exposed through altus documents' };
  }

  try {
    const { rows } = await pool.query(
      `UPDATE agent_memory
          SET value = $1, updated_at = NOW()
        WHERE agent = 'hal' AND key = $2
        RETURNING updated_at`,
      [value, key],
    );

    if (rows.length === 0) {
      return { success: false, error: 'not_found' };
    }

    return { success: true, key, updated_at: rows[0].updated_at };
  } catch (err) {
    logger.error('altus-documents: save failed', { error: err.message, key });
    throw err;
  }
}
