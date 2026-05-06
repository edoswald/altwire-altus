/**
 * safeToolHandler — wraps MCP tool handlers in a try/catch.
 * Returns structured { exit_reason: 'tool_error' } on unexpected exceptions
 * instead of propagating the error to the MCP transport.
 *
 * Also enforces per-client tool allowlists from OAuth context.
 * All tool calls are automatically logged to altus_events (fire-and-forget).
 *
 * Error responses include tool name for debugging.
 * In production (NODE_ENV=production), the internal error message is suppressed
 * to avoid leaking implementation details.
 */

import { AsyncLocalStorage } from 'async_hooks';

export const sessionIdStorage = new AsyncLocalStorage();
export const oauthClientStorage = new AsyncLocalStorage();

import { logger } from '../logger.js';
import { emitEvent } from './altus-event-bus.js';

let _logAltusEvent = null;
async function getLogAltusEvent() {
  if (_logAltusEvent !== null) return _logAltusEvent;
  try {
    const mod = await import('../altus-event-log.js');
    _logAltusEvent = mod.logAltusEvent ?? null;
  } catch {
    _logAltusEvent = null;
  }
  return _logAltusEvent;
}

/**
 * @param {string} toolName
 * @param {function} handler - async (params, sessionId?) => MCP result object
 * @returns {function} async (params) => MCP result object
 */
export function safeToolHandler(toolName, handler) {
  return async (params) => {
    const clientCtx = oauthClientStorage.getStore();
    if (clientCtx?.allowedTools && !clientCtx.allowedTools.has(toolName)) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'tool_not_allowed_for_client' }) }],
      };
    }

    const sessionId = sessionIdStorage.getStore();
    const start = Date.now();

    // Fire-and-forget event emission
    emitEvent(sessionId, { event: 'tool_start', tool: toolName, label: toolName.replace(/_/g, ' ') });

    try {
      const result = await handler(params, sessionId);
      const durationMs = Date.now() - start;
      emitEvent(sessionId, { event: 'tool_done', tool: toolName, success: true, duration_ms: durationMs });

      // Async log — do not block response
      getLogAltusEvent().then(logFn => {
        if (logFn) logFn('tool_call', { tool_name: toolName, session_id: sessionId ? Number(sessionId) : null, duration_ms: durationMs }).catch((err) => logger.warn('altus_event_log insert failed', { tool_name: toolName, error: err.message }));
      });

      return result;
    } catch (err) {
      const durationMs = Date.now() - start;
      logger.error('Unexpected tool handler error', {
        error: err.message,
        stack: err.stack,
      });
      const isProd = process.env.NODE_ENV === 'production';
      emitEvent(sessionId, { event: 'tool_done', tool: toolName, success: false, error: err.message, duration_ms: durationMs });

      // Async log — do not block response
      getLogAltusEvent().then(logFn => {
        if (logFn) logFn('tool_error', { tool_name: toolName, session_id: sessionId ? Number(sessionId) : null, error_message: err.message, duration_ms: durationMs }).catch((logErr) => logger.warn('altus_event_log insert failed', { tool_name: toolName, error: logErr.message }));
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: false,
              exit_reason: 'tool_error',
              message: isProd ? 'An unexpected error occurred.' : err.message,
            }),
          },
        ],
      };
    }
  };
}

export function emitToolEvent(eventType, toolName, label, extras = {}) {
  const sessionId = sessionIdStorage.getStore();
  if (!sessionId) return;
  emitEvent(sessionId, {
    event: eventType,
    tool: toolName,
    label,
    ...extras,
  });
}
