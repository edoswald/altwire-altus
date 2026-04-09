/**
 * safeToolHandler — wraps MCP tool handlers in a try/catch.
 * Returns structured { exit_reason: 'tool_error' } on unexpected exceptions
 * instead of propagating the error to the MCP transport.
 *
 * This is a standalone version for Altus — no scope gating needed.
 */

import { logger } from '../logger.js';

/**
 * @param {function} handler - async (params) => MCP result object
 * @returns {function} async (params) => MCP result object
 */
export function safeToolHandler(handler) {
  return async (params) => {
    try {
      return await handler(params);
    } catch (err) {
      logger.error('Unexpected tool handler error', {
        error: err.message,
        stack: err.stack,
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: false,
              exit_reason: 'tool_error',
              message: 'An unexpected error occurred.',
            }),
          },
        ],
      };
    }
  };
}
