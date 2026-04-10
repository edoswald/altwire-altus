/**
 * reingest_altwire_archive handler.
 * Re-runs the AltWire ingestion pipeline. Pulls all (or recent) posts and galleries,
 * regenerates embeddings, and upserts to the archive.
 */

import { upsertContent, logIngestRun } from '../lib/altus-db.js';
import { fetchAllPosts, fetchAllGalleries } from '../lib/wp-client.js';
import { embedDocuments } from '../lib/voyage.js';
import { synthesizeGallery } from '../lib/synthesizer.js';
import { logger } from '../logger.js';

/**
 * Embed and upsert an array of post documents.
 * @returns {{ count: number, errors: number }}
 */
async function embedAndUpsert(posts) {
  if (posts.length === 0) return { count: 0, errors: 0 };

  const embedTexts = posts.map((p) => {
    const cats = p.categories.join(', ');
    const tags = p.tags.join(', ');
    return `${p.title}\n\n${cats}\n${tags}\n\n${p.raw_text}`.slice(0, 3000);
  });

  const embeddings = await embedDocuments(embedTexts);
  if (embeddings?.error) {
    logger.error('Post embedding failed', { error: embeddings.error });
    return { count: 0, errors: posts.length };
  }

  let count = 0;
  let errors = 0;
  for (let i = 0; i < posts.length; i++) {
    try {
      await upsertContent({ ...posts[i], embedding: embeddings[i] });
      count++;
    } catch (err) {
      logger.warn('Post upsert failed', { wp_id: posts[i].wp_id, error: err.message });
      errors++;
    }
  }
  return { count, errors };
}

/**
 * Synthesize, embed, and upsert gallery documents.
 * @returns {{ count: number, errors: number }}
 */
async function embedAndUpsertGalleries(galleries) {
  if (galleries.length === 0) return { count: 0, errors: 0 };

  const synthesized = [];
  let synthErrors = 0;
  for (const gallery of galleries) {
    try {
      const synthesis = await synthesizeGallery(gallery);
      const tags = (gallery.tags ?? []).join(', ');
      const embedText = `${gallery.title}\n\nPhoto gallery\n${tags}\n\n${synthesis}`.slice(0, 8000);
      synthesized.push({ gallery, synthesis, embedText });
    } catch (err) {
      logger.warn('Gallery synthesis failed', { id: gallery.id, error: err.message });
      synthErrors++;
    }
  }

  const embedTexts = synthesized.map((s) => s.embedText);
  const embeddings = await embedDocuments(embedTexts);
  if (embeddings?.error) {
    logger.error('Gallery embedding failed', { error: embeddings.error });
    return { count: 0, errors: synthErrors + synthesized.length };
  }

  let count = 0;
  let errors = synthErrors;
  for (let i = 0; i < synthesized.length; i++) {
    const { gallery, synthesis } = synthesized[i];
    try {
      await upsertContent({
        wp_id: gallery.id,
        content_type: 'gallery',
        title: gallery.title,
        slug: gallery.slug ?? null,
        url: gallery.url ?? null,
        published_at: null,
        author: null,
        categories: [],
        tags: gallery.tags ?? [],
        raw_text: synthesis,
        embedding: embeddings[i],
      });
      count++;
    } catch (err) {
      logger.warn('Gallery upsert failed', { id: gallery.id, error: err.message });
      errors++;
    }
  }
  return { count, errors };
}

/**
 * @param {{ mode: 'full'|'recent', dry_run: boolean }} params
 * @returns {Promise<object>}
 */
export async function reIngestHandler({ mode, dry_run }) {
  if (!process.env.DATABASE_URL) {
    return { success: false, error: 'Database not configured' };
  }

  const startTime = Date.now();

  const afterDate = mode === 'recent'
    ? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    : null;

  logger.info('Reingest started', { mode, dry_run, afterDate });

  const [posts, galleries] = await Promise.all([
    fetchAllPosts(afterDate),
    fetchAllGalleries(),
  ]);

  logger.info('Content fetched', { posts: posts.length, galleries: galleries.length });

  let postsIngested = 0;
  let galleriesIngested = 0;
  let errors = 0;

  if (!dry_run) {
    const postResult = await embedAndUpsert(posts);
    postsIngested = postResult.count;
    errors += postResult.errors;

    const galleryResult = await embedAndUpsertGalleries(galleries);
    galleriesIngested = galleryResult.count;
    errors += galleryResult.errors;

    await logIngestRun({
      mode,
      postsIngested,
      galleriesIngested,
      errors,
      durationMs: Date.now() - startTime,
      notes: null,
    });
  }

  const result = {
    success: true,
    mode,
    dry_run,
    posts_processed: posts.length,
    galleries_processed: galleries.length,
    posts_ingested: dry_run ? 0 : postsIngested,
    galleries_ingested: dry_run ? 0 : galleriesIngested,
    errors,
    duration_ms: Date.now() - startTime,
  };

  logger.info('Reingest complete', result);
  return result;
}
