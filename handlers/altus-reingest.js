/**
 * reingest_altwire_archive handler.
 * Re-runs the AltWire ingestion pipeline. Pulls all (or recent) posts and galleries,
 * regenerates embeddings, and upserts to the archive.
 */

import { logIngestRun, hasDbConfig } from '../lib/altus-db.js';
import { fetchAllPosts, fetchAllGalleries } from '../lib/wp-client.js';
import { embedAndUpsertPosts, embedAndUpsertGalleries, filterGalleriesForWindow } from '../lib/ingest-pipeline.js';
import { logger } from '../logger.js';

/**
 * @param {{ mode: 'full'|'recent', dry_run: boolean, batch_synthesis?: boolean }} params
 * @returns {Promise<object>}
 */
export async function reIngestHandler({ mode, dry_run, batch_synthesis = false }) {
  if (!hasDbConfig()) {
    return { success: false, error: 'Database not configured' };
  }

  const startTime = Date.now();

  const afterDate = mode === 'recent'
    ? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    : null;

  logger.info('Reingest started', { mode, dry_run, afterDate, batch_synthesis });

  const [posts, allGalleries] = await Promise.all([
    fetchAllPosts(afterDate),
    fetchAllGalleries(),
  ]);
  const galleries = await filterGalleriesForWindow(allGalleries, afterDate);

  logger.info('Content fetched', {
    posts: posts.length,
    galleries: galleries.length,
    galleries_total: allGalleries.length,
  });

  let postsIngested = 0;
  let galleriesIngested = 0;
  let gallerySkipped = 0;
  let errors = 0;

  if (!dry_run) {
    const postResult = await embedAndUpsertPosts(posts);
    postsIngested = postResult.count;
    errors += postResult.errors;

    const galleryResult = await embedAndUpsertGalleries(galleries, { useBatch: batch_synthesis });
    galleriesIngested = galleryResult.count;
    gallerySkipped = galleryResult.skipped ?? 0;
    errors += galleryResult.errors;

    await logIngestRun({
      mode,
      postsIngested,
      galleriesIngested,
      errors,
      durationMs: Date.now() - startTime,
      notes: gallerySkipped > 0 ? `Galleries skipped (no material): ${gallerySkipped}` : null,
    });
  }

  const result = {
    success: true,
    mode,
    dry_run,
    batch_synthesis,
    posts_processed: posts.length,
    galleries_processed: galleries.length,
    posts_ingested: dry_run ? 0 : postsIngested,
    galleries_ingested: dry_run ? 0 : galleriesIngested,
    galleries_skipped_no_material: dry_run ? 0 : gallerySkipped,
    errors,
    duration_ms: Date.now() - startTime,
  };

  logger.info('Reingest complete', result);
  return result;
}
