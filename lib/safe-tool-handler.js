/**
 * safeToolHandler — wraps MCP tool handlers in a try/catch.
 * Returns structured { exit_reason: 'tool_error' } on unexpected exceptions
 * instead of propagating the error to the MCP transport.
 *
 * Also enforces per-client tool allowlists from OAuth context.
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
    try {
      return await handler(params, sessionId);
    } catch (err) {
      logger.error('Unexpected tool handler error', {
        error: err.message,
        stack: err.stack,
      });
      const isProd = process.env.NODE_ENV === 'production';
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
