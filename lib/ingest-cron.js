/**
 * Daily ingest scheduler.
 *
 * Spawns scripts/ingest.js as a child process every day (default 03:00 UTC).
 * Runs in-process alongside the MCP server — logs appear in Railway's
 * Observability tab.
 *
 * If a clean ingest already ran in the last few hours (another instance on
 * the same database got there first), the run only scores new/edited
 * reviews. ALTUS_INGEST_CRON changes the schedule; ALTUS_RUN_CRONS /
 * ALTUS_SKIP_CRONS (job name daily_ingest) decide which instance runs it.
 *
 * The cron runs in `--recent` (incremental) mode: only posts published or
 * modified in the last 30 days and galleries that are new to the archive are
 * fetched, re-synthesized, and re-embedded — so the nightly sync does not
 * re-bill the whole corpus. Use reingest_altwire_archive { mode: 'full' }
 * explicitly when a full re-embed is wanted (e.g. after an embedding-model
 * change).
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
import { getLastSuccessfulIngestRun } from './altus-db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INGEST_SCRIPT = join(__dirname, '..', 'scripts', 'ingest.js');
const SCORE_SCRIPT = join(__dirname, '..', 'scripts', 'score-reviews.js');

export const DEFAULT_INGEST_CRON = '0 3 * * *';
// A clean ingest this recent means another instance sharing the database
// already synced tonight; only score reviews.
export const RECENT_INGEST_HOURS = 6;
const REVIEW_SCORING_LIMIT = '40';

function runChild(label, script, args) {
  const child = spawn(process.execPath, ['--no-deprecation', script, ...args], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (data) => process.stdout.write(data));
  child.stderr.on('data', (data) => process.stderr.write(data));

  child.on('close', (code) => {
    if (code === 0) {
      logger.info(`Cron: ${label} completed successfully`);
    } else {
      logger.error(`Cron: ${label} finished with errors`, { exitCode: code });
    }
  });

  child.on('error', (err) => {
    logger.error(`Cron: failed to spawn ${label} process`, { error: err.message });
  });
  return child;
}

/**
 * Nightly run. Syncs recent posts (which also scores new/edited reviews),
 * unless a clean sync already ran within RECENT_INGEST_HOURS, in which case
 * it only scores reviews.
 */
export async function runIngest({ lastRunLookup = getLastSuccessfulIngestRun, now = Date.now() } = {}) {
  const lastRun = await lastRunLookup();
  const hoursSince = lastRun ? (now - new Date(lastRun).getTime()) / 3600000 : Infinity;
  if (hoursSince < RECENT_INGEST_HOURS) {
    logger.info('Cron: ingest already ran recently; scoring reviews only', { last_run: lastRun });
    return runChild('review scoring', SCORE_SCRIPT, ['--limit', REVIEW_SCORING_LIMIT]);
  }
  logger.info('Cron: starting daily ingest run (recent mode)');
  return runChild('daily ingest', INGEST_SCRIPT, ['--recent']);
}

/**
 * Start the daily ingest cron. Call once at server startup.
 * @param {{ expression?: string }} [opts]  cron schedule in UTC (default 03:00)
 */
export function startIngestCron({ expression = DEFAULT_INGEST_CRON } = {}) {
  let schedule = expression;
  if (cron.validate && !cron.validate(schedule)) {
    logger.error('Cron: invalid ALTUS_INGEST_CRON; using the default', { expression });
    schedule = DEFAULT_INGEST_CRON;
  }
  cron.schedule(schedule, () => runIngest().catch((err) => {
    logger.error('Cron: daily ingest failed to start', { error: err.message });
  }), { timezone: 'UTC' });
  logger.info('Cron: daily ingest scheduled', { schedule, timezone: 'UTC' });
}
