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
 * Strip PII and sensitive fields from tool params before logging to Laminar.
 * @param {object} params — raw tool parameters
 * @returns {object} — sanitized params
 */
export function sanitizeToolParams(params) {
  if (!params || typeof params !== 'object') return params ?? {};
  const sanitized = { ...params };
  const piiFields = ['email', 'phone', 'order_id', 'phone_number', 'billing_phone'];
  for (const field of piiFields) {
    if (field in sanitized) delete sanitized[field];
  }
  for (const key of Object.keys(sanitized)) {
    if (key.toLowerCase().includes('password')) delete sanitized[key];
  }
  return sanitized;
}

/**
 * Wrap a handler function with a Laminar span.
 *
 * @param {{ name: string, spanType?: 'DEFAULT'|'LLM'|'TOOL', metadata?: object }} options
 * @param {Function} fn - async function to wrap
 * @param {object} [params] - params to sanitize before logging
 * @returns {Function} - wrapped function
 */
export function observe(options, fn, params) {
  initObserve().catch(() => {});

  if (_observeFn) {
    return _observeFn(options, fn, params);
  }
  return fn;
}