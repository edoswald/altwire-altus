/**
 * Structured JSON logger — writes to stderr, never stdout.
 * stdout is reserved for MCP stdio transport.
 */

const priority = { debug: 0, info: 1, warn: 2, error: 3 };

function log(level, message, meta = {}) {
  const minLevel = process.env.LOG_LEVEL || 'info';
  if ((priority[level] ?? 0) < (priority[minLevel] ?? 1)) return;
  const entry = {
    timestamp: new Date().toISOString(),
    level: level.toUpperCase(),
    message,
    ...meta,
  };
  process.stderr.write(JSON.stringify(entry) + '\n');
}

export const logger = {
  debug: (msg, meta) => log('debug', msg, meta),
  info:  (msg, meta) => log('info',  msg, meta),
  warn:  (msg, meta) => log('warn',  msg, meta),
  error: (msg, meta) => log('error', msg, meta),
};
