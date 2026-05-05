/**
 * tracing.js — Laminar @observe decorator wrapper with graceful fallback.
 *
 * Mirrors the pattern used in cirrusly-dave/tracing.py and cirrusly-nimbus/tracing.js.
 * - LMNR_PROJECT_API_KEY checked at decoration time (not module init)
 * - Lazy-initializes _observeFn on first use — avoids top-level await
 * - Falls back to no-op passthrough when Laminar is unavailable
 *
 * Usage:
 *   import { observe } from './tracing.js';
 *
 *   export async function runSession(options) {
 *     return observe({ name: 'altus_session', spanType: 'LLM' }, async () => {
 *       // All code runs inside a Laminar trace
 *     })();
 *   }
 *
 * The Laminar SDK auto-instruments Anthropic API calls globally when
 * initialized, so LLM spans appear even without explicit wrapping.
 */

import { logger } from './logger.js';

let _observeFn = null;
let _initialized = false;

async function initObserve() {
  if (_initialized) return;
  _initialized = true;

  if (!process.env.LMNR_PROJECT_API_KEY) {
    return;
  }
  try {
    const lmnr = await import('@lmnr-ai/lmnr');
    _observeFn = lmnr.observe ?? lmnr.default?.Laminar?.observe ?? null;
    if (_observeFn) {
      logger.info('[tracing] Laminar @observe enabled');
    }
  } catch (err) {
    logger.warn('[tracing] Failed to load Laminar SDK:', err.message);
  }
}

/**
 * Wrap a handler function with a Laminar span.
 *
 * @param {{ name: string, spanType?: 'DEFAULT'|'LLM'|'TOOL' }} options
 * @param {Function} fn - async function to wrap
 * @returns {Function} - wrapped function
 */
export function observe(options, fn) {
  initObserve().catch(() => {});

  if (_observeFn) {
    return _observeFn(options, fn);
  }
  return fn;
}