/**
 * anthropic-cache.js
 *
 * Shared helpers for Anthropic prompt caching (explicit cache breakpoints).
 *
 * A single `cache_control: { type: 'ephemeral' }` breakpoint on the LAST
 * block of a stable prefix lets Anthropic cache that prefix (tool schemas +
 * system prompt, or the accumulated conversation) so repeated calls are
 * billed at the discounted cache-read rate instead of full input price.
 *
 * Usage mirrors the pattern already proven in the /hal/chat flow and the
 * writer client: place one breakpoint on the tail of whatever prefix is
 * identical from call to call.
 */

const EPHEMERAL = Object.freeze({ type: 'ephemeral' });

/**
 * Wrap a stable system prompt (string or block array) so its final block
 * carries a cache breakpoint.
 *
 * When combined with `tools`, the breakpoint lands after the tool schemas
 * (render order is tools → system → messages), caching schemas + system in
 * a single write.
 *
 * @param {string | Array<{ type: string, text?: string }>} system - system prompt
 * @returns {Array<{ type: string, text?: string, cache_control?: object }>} content block array
 */
export function withCachedSystem(system) {
  const blocks = Array.isArray(system)
    ? system.map((b) => ({ ...b }))
    : [{ type: 'text', text: system }];
  if (!blocks.length) return blocks;
  const last = blocks[blocks.length - 1];
  blocks[blocks.length - 1] = { ...last, cache_control: EPHEMERAL };
  return blocks;
}

/**
 * Add a rolling cache breakpoint on the most-recent message so the growing
 * conversation prefix (history + tool results) is served from cache across
 * agentic-loop iterations and follow-up turns.
 *
 * The breakpoint is placed on the LAST content block of the final message —
 * the most recent token boundary that is still present on the next call.
 *
 * @param {Array<{ role: string, content: string | Array<object> }>} messages
 * @returns {Array<{ role: string, content: string | Array<object> }>} new array; unchanged content when content is empty or not a string/array
 */
export function withRollingConversationCache(messages) {
  if (!Array.isArray(messages) || !messages.length) return messages;
  const out = messages.slice();
  const last = out[out.length - 1];
  let content = last.content;

  if (typeof content === 'string') {
    content = [{ type: 'text', text: content, cache_control: EPHEMERAL }];
  } else if (Array.isArray(content) && content.length) {
    content = content.map((block, index) =>
      index === content.length - 1 ? { ...block, cache_control: EPHEMERAL } : block,
    );
  } else {
    return messages;
  }

  out[out.length - 1] = { ...last, content };
  return out;
}