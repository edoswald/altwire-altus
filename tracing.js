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
 *     });
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
    const rawObs = lmnr.observe ?? lmnr.default?.Laminar?.observe ?? null;
    if (typeof rawObs === 'function' && rawObs.length >= 2) {
      _observeFn = rawObs;
      logger.info('[tracing] Laminar @observe enabled');
    } else {
      logger.warn('[tracing] Laminar SDK loaded but observe is not a callable function:', typeof rawObs);
    }
  } catch (err) {
    logger.warn('[tracing] Failed to load Laminar SDK:', err.message);
  }
}

/**
 * Strip PII and sensitive fields from tool params / root inputs before logging to Laminar.
 * @param {object} params — raw parameters
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
 * observe(options, fn) returns a Promise — await it directly:
 *   return observe({ name: 'altus_heartbeat' }, async () => { ... });
 *
 * @param {{ name: string, spanType?: 'DEFAULT'|'LLM'|'TOOL', metadata?: object, input?: unknown }} options
 * @param {Function} fn - async function to wrap
 * @param {object} [params] - params to sanitize before logging
 * @returns {Function} - wrapped function
 */
export function observe(options, fn, params) {
  initObserve().catch(() => {});

  if (_observeFn) {
    let sanitizedInput = options.input;
    if (sanitizedInput != null) {
      const wrapped = sanitizeToolParams({ message: sanitizedInput });
      sanitizedInput = wrapped.message;
    }
    const opts = { ...options, input: sanitizedInput };
    let wrappedFnEntered = false;
    const wrappedFn = async () => {
      wrappedFnEntered = true;
      const result = await fn(params);
      return sanitizeToolParams(result);
    };
    try {
      return _observeFn(opts, wrappedFn, params);
    } catch (err) {
      if (wrappedFnEntered) throw err;
      logger.warn('[tracing] Laminar observe failed, falling back to passthrough:', err.message);
      return fn(params);
    }
  }
  return fn(params);
}
