/**
 * AltWire content ingestion script.
 *
 * Runs on demand or via the daily cron (lib/ingest-cron.js) to populate
 * altus_content with embeddings.
 *
 *   node scripts/ingest.js                 # incremental: since the last successful run
 *   node scripts/ingest.js --full          # re-embed the entire corpus
 *   node scripts/ingest.js --recent        # last 30 days of posts + new galleries
 *   node scripts/ingest.js --after=2026-09-01T00:00:00.000Z   # custom window
 *   node scripts/ingest.js --batch-synthesis   # route gallery synthesis through Batch API
 *
 * Re-runs are safe — ON CONFLICT DO UPDATE ensures idempotency.
 */

import { initSchema, logIngestRun, getLastSuccessfulIngestRun } from '../lib/altus-db.js';
import { fetchTaxonomies, fetchPosts, fetchGalleries } from '../lib/wp-client.js';
import { embedAndUpsertPosts, embedAndUpsertGalleries, filterGalleriesForWindow } from '../lib/ingest-pipeline.js';
import { logger } from '../logger.js';

const required = ['DATABASE_URL', 'ALTWIRE_WP_URL', 'ALTWIRE_WP_USER', 'ALTWIRE_WP_APP_PASSWORD', 'VOYAGE_API_KEY', 'ANTHROPIC_API_KEY'];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing required env var: ${key}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const mode = args.includes('--full') ? 'full' : (args.includes('--recent') ? 'recent' : 'incremental');
const afterArg = args.find((a) => a.startsWith('--after='))?.slice('--after='.length) ?? null;
const batchSynthesis = args.includes('--batch-synthesis');

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Resolve the `after` window: explicit --after wins, then --full (all), then
 * --recent (30d), then incremental (last successful run, falling back to 30d).
 */
async function resolveAfterDate() {
  if (afterArg) return afterArg;
  if (mode === 'full') return null;
  if (mode === 'recent') return isoDaysAgo(30);

  const lastRun = await getLastSuccessfulIngestRun();
  if (lastRun) {
    logger.info('Incremental run — window since last successful ingest', { since: lastRun });
    return lastRun;
  }
  logger.warn('Incremental run but no previous successful ingest found — falling back to last 30 days');
  return isoDaysAgo(30);
}

const startTime = Date.now();
let postsIngested = 0;
let galleriesIngested = 0;
let galleriesSkipped = 0;
let errors = 0;

async function main() {
  const afterDate = await resolveAfterDate();
  logger.info('Starting Altus ingestion run', { mode, afterDate, batchSynthesis });

  await initSchema();

  const caches = await fetchTaxonomies();

  // --- Posts --------------------------------------------------------------
  logger.info('Fetching posts from WordPress...');
  const posts = await fetchPosts(caches, afterDate);
  logger.info(`Fetched ${posts.length} posts — embedding...`);

  const postResult = await embedAndUpsertPosts(posts);
  postsIngested = postResult.count;
  errors += postResult.errors;

  // --- Galleries -----------------------------------------------------------
  logger.info('Fetching galleries from WordPress...');
  const allGalleries = await fetchGalleries();
  const galleries = await filterGalleriesForWindow(allGalleries, afterDate);
  logger.info(`Fetched ${galleries.length} galleries to process (of ${allGalleries.length} total)`);

  const galleryResult = await embedAndUpsertGalleries(galleries, { useBatch: batchSynthesis });
  galleriesIngested = galleryResult.count;
  galleriesSkipped = galleryResult.skipped ?? 0;
  errors += galleryResult.errors;

  const durationMs = Date.now() - startTime;
  await logIngestRun({
    mode,
    postsIngested,
    galleriesIngested,
    errors,
    durationMs,
    notes: galleriesSkipped > 0 ? `Galleries skipped (no material): ${galleriesSkipped}` : `Ingestion complete. Posts: ${postsIngested}, Galleries: ${galleriesIngested}, Errors: ${errors}`,
  });

  console.log(`\nIngestion complete in ${(durationMs / 1000).toFixed(1)}s`);
  console.log(`  Posts:     ${postsIngested}`);
  console.log(`  Galleries: ${galleriesIngested} (${galleriesSkipped} skipped — no synthesizable material)`);
  console.log(`  Errors:    ${errors}`);
  process.exit(errors > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal ingest error:', err.message);
  process.exit(1);
});
