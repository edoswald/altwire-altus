/**
 * model-ids.js
 *
 * Current Claude model IDs plus a forward map for retired IDs that may still
 * be pinned in env vars (Railway) or stored settings. Stale pins are mapped to
 * their replacement instead of being sent to the API (where they would 404 or
 * hit removed parameters).
 */

export const MODEL_HAIKU = 'claude-haiku-5-5';
export const MODEL_SONNET = 'claude-sonnet-5-5';
export const MODEL_OPUS = 'claude-opus-5-5';
export const MODEL_FABLE = 'claude-fable-5-1';

const LEGACY_MODEL_MAP = {
  'claude-haiku-4-5': MODEL_HAIKU,
  'claude-haiku-4-5-20251001': MODEL_HAIKU,
  'claude-haiku-4-5-20250514': MODEL_HAIKU, // never a real ID
  'claude-sonnet-4-5': MODEL_SONNET,
  'claude-sonnet-4-5-20250929': MODEL_SONNET,
  'claude-sonnet-4-6': MODEL_SONNET,
  'claude-sonnet-5': MODEL_SONNET,
  'claude-opus-4-5': MODEL_OPUS,
  'claude-opus-4-6': MODEL_OPUS,
  'claude-opus-4-7': MODEL_OPUS,
  'claude-opus-4-8': MODEL_OPUS,
  'claude-opus-5': MODEL_OPUS,
  'claude-fable-5': MODEL_FABLE,
};

/**
 * Resolve a model ID (typically from an env var) to a current one.
 * Unknown IDs (including non-Anthropic models) pass through unchanged.
 *
 * @param {string | undefined | null} id
 * @param {string} fallback - used when `id` is empty
 * @returns {string}
 */
export function resolveModel(id, fallback) {
  const trimmed = typeof id === 'string' ? id.trim() : '';
  if (!trimmed) return fallback;
  return LEGACY_MODEL_MAP[trimmed] ?? trimmed;
}

/**
 * Concatenate the text blocks of a Messages API response. Responses from
 * 5.5-generation models can start with a thinking block, so never read
 * `content[0].text`. Throws on `stop_reason: "refusal"` so callers take their
 * existing error path.
 *
 * @param {{ content?: Array<{ type: string, text?: string }>, stop_reason?: string, stop_details?: object }} response
 * @returns {string}
 */
export function getResponseText(response) {
  if (response?.stop_reason === 'refusal') {
    const category = response?.stop_details?.category;
    throw new Error(`Claude refused the request${category ? ` (${category})` : ''}`);
  }
  return (response?.content ?? [])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text ?? '')
    .join('');
}
