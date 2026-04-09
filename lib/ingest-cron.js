/**
 * Daily ingest scheduler.
 *
 * Spawns scripts/ingest.js as a child process every day at 03:00 UTC.
 * Runs in-process alongside the MCP server — logs appear in Railway's
 * Observability tab.
 *
 * Requires all ingest env vars to be set in the Railway service:
 *   DATABASE_URL, ALTWIRE_WP_URL, ALTWIRE_WP_USER, ALTWIRE_WP_APP_PASSWORD,
 *   VOYAGE_API_KEY, ANTHROPIC_API_KEY
 */

import cron from 'node-cron';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { logger } from '../logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INGEST_SCRIPT = join(__dirname, '..', 'scripts', 'ingest.js');

function runIngest() {
  logger.info('Cron: starting daily ingest run');

  const child = spawn(process.execPath, ['--no-deprecation', INGEST_SCRIPT], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (data) => process.stderr.write(data));
  child.stderr.on('data', (data) => process.stderr.write(data));

  child.on('close', (code) => {
    if (code === 0) {
      logger.info('Cron: daily ingest completed successfully');
    } else {
      logger.error('Cron: daily ingest finished with errors', { exitCode: code });
    }
  });

  child.on('error', (err) => {
    logger.error('Cron: failed to spawn ingest process', { error: err.message });
  });
}

/**
 * Start the daily ingest cron. Call once at server startup.
 * Schedule: 03:00 UTC every day.
 */
export function startIngestCron() {
  cron.schedule('0 3 * * *', runIngest, { timezone: 'UTC' });
  logger.info('Cron: daily ingest scheduled at 03:00 UTC');
}
