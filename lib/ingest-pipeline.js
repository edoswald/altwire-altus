/**
 * ingest-pipeline.js
 *
 * Shared embed + upsert pipelines for AltWire content ingestion, used by both
 * scripts/ingest.js and handlers/altus-reingest.js so the two code paths cannot
 * drift.
 *
 * - Posts:  build embed text → batch embed → upsert.
 * - Galleries: synthesize descriptions (sequential-with-concurrency, or via the
 *   Anthropic Batch API with useBatch), embed, upsert.
 * - Window filtering: recent/incremental runs use the WP `after` window for
 *   posts and — because the NGG galleries endpoint exposes no timestamps —
 *   include only galleries that are either timestamped within the window or
 *   brand-new to the archive.
 */

import { upsertContent, getIndexedGalleryIds } from './altus-db.js';
import { embedDocuments } from './voyage.js';
import { synthesizeGallery, hasSynthesizableMaterial, buildGallerySynthesisRequest } from './synthesizer.js';
import { submitBatch, waitForBatch, logBatchUsage } from '../batch-client.js';
import { logger } from '../logger.js';

export const GALLERY_SYNTHESIS_CONCURRENCY = 5;
export const GALLERY_BATCH_SUBMIT_SIZE = 200;

function buildPostEmbedText(post) {
  const cats = post.categories.join(', ');
  const tags = post.tags.join(', ');
  return `${post.title}\n\n${cats}\n${tags}\n\n${post.raw_text}`.slice(0, 3000);
}

function buildGalleryEmbedText(gallery, synthesis) {
  const tags = (gallery.tags ?? []).join(', ');
  return `${gallery.title}\n\nPhoto gallery\n${tags}\n\n${synthesis}`.slice(0, 8000);
}

/**
 * Map over an array with a bounded concurrency pool.
 */
async function runWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Best-effort timestamp extraction for a gallery from the WP endpoint.
 * The /altus/v1/galleries response does not currently include timestamps, so
 * this returns null for nearly all galleries.
 */
export function galleryTimestamp(gallery) {
  const candidate = gallery.modified_at ?? gallery.updated_at ?? gallery.created_at ?? gallery.date ?? null;
  if (!candidate) return null;
  const parsed = new Date(candidate);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Window-filter galleries for recent/incremental runs:
 * - galleries with a parseable timestamp at/after the threshold are kept;
 * - galleries WITHOUT a timestamp (the normal case) are kept only when they are
 *   not already indexed, so daily syncs never re-synthesize existing galleries.
 *
 * @param {Array<object>} galleries
 * @param {string|null} afterDate - ISO threshold; null (full run) keeps everything
 * @returns {Promise<Array<object>>}
 */
export async function filterGalleriesForWindow(galleries, afterDate) {
  if (!afterDate) return galleries;
  const threshold = new Date(afterDate);

  const timed = galleries.filter((g) => {
    const ts = galleryTimestamp(g);
    return ts ? ts >= threshold : false;
  });
  const untimed = galleries.filter((g) => !galleryTimestamp(g));
  if (untimed.length === 0) return timed;

  const indexed = new Set(await getIndexedGalleryIds());
  const fresh = untimed.filter((g) => !indexed.has(Number(g.id)));

  if (fresh.length > 0 || timed.length > 0) {
    logger.info('Gallery window filter', {
      within_window: timed.length,
      new_since_last_index: fresh.length,
      already_indexed_skipped: untimed.length - fresh.length,
      total_processing: timed.length + fresh.length,
    });
  }
  return [...timed, ...fresh];
}

/**
 * Synthesize gallery descriptions with a bounded concurrency pool. Galleries
 * with no synthesizable material skip the Claude call entirely (handled inside
 * synthesizeGallery) — they are reported in `skipped`.
 */
async function synthesizeGalleryDescriptions(galleries) {
  const synthesized = [];
  let errors = 0;
  let skipped = 0;

  await runWithConcurrency(galleries, GALLERY_SYNTHESIS_CONCURRENCY, async (gallery) => {
    try {
      if (!hasSynthesizableMaterial(gallery)) skipped++;
      const synthesis = await synthesizeGallery(gallery);
      synthesized.push({ gallery, synthesis, embedText: buildGalleryEmbedText(gallery, synthesis) });
    } catch (err) {
      logger.warn('Gallery synthesis failed', { id: gallery.id, error: err.message });
      errors++;
    }
  });

  return { synthesized, errors, skipped };
}

/**
 * Synthesize gallery descriptions through the Anthropic Batch API. Galleries
 * without material use the free deterministic fallback; the rest are submitted
 * in one or more chunks and awaited inline.
 */
async function synthesizeGalleryDescriptionsBatch(galleries) {
  const synthesized = [];
  let errors = 0;
  let skipped = 0;

  const pending = [];
  for (const gallery of galleries) {
    if (!hasSynthesizableMaterial(gallery)) {
      skipped++;
      const synthesis = await synthesizeGallery(gallery); // fallback only — no API call
      if (!synthesis?.trim()) { errors++; continue; }
      synthesized.push({ gallery, synthesis, embedText: buildGalleryEmbedText(gallery, synthesis) });
    } else {
      pending.push({ gallery, customId: `gallery-${gallery.id}` });
    }
  }

  for (let i = 0; i < pending.length; i += GALLERY_BATCH_SUBMIT_SIZE) {
    const chunk = pending.slice(i, i + GALLERY_BATCH_SUBMIT_SIZE);
    const requests = chunk.map(({ gallery, customId }) => ({
      custom_id: customId,
      params: buildGallerySynthesisRequest(gallery),
    }));

    let results;
    try {
      const batchId = await submitBatch(requests);
      logger.info('Gallery synthesis batch submitted', { batch_id: batchId, requests: requests.length });
      results = await waitForBatch(batchId);
      await logBatchUsage(batchId, results, 'synthesize_gallery');
    } catch (err) {
      logger.error('Gallery synthesis batch failed', { error: err.message, requests: chunk.length });
      errors += chunk.length;
      continue;
    }

    const byId = new Map(results.map((r) => [r.custom_id, r]));
    for (const { gallery, customId } of chunk) {
      const item = byId.get(customId);
      const text = item?.result?.type === 'succeeded'
        ? item.result.message?.content?.find((b) => b.type === 'text')?.text
        : null;
      if (!text?.trim()) {
        errors++;
        logger.warn('Gallery synthesis batch item failed', { custom_id: customId });
        continue;
      }
      synthesized.push({ gallery, synthesis: text.trim(), embedText: buildGalleryEmbedText(gallery, text) });
    }
  }

  return { synthesized, errors, skipped };
}

/**
 * Embed and upsert post documents.
 * @returns {{ count: number, errors: number }}
 */
export async function embedAndUpsertPosts(posts) {
  if (posts.length === 0) return { count: 0, errors: 0 };

  const embedTexts = posts.map(buildPostEmbedText);
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
 * @param {Array<object>} galleries - already window-filtered
 * @param {{ useBatch?: boolean }} [opts] - true routes synthesis through the Batch API
 * @returns {{ count: number, errors: number, skipped: number }}
 */
export async function embedAndUpsertGalleries(galleries, { useBatch = false } = {}) {
  if (galleries.length === 0) return { count: 0, errors: 0, skipped: 0 };

  const { synthesized, errors: synthErrors, skipped } = useBatch
    ? await synthesizeGalleryDescriptionsBatch(galleries)
    : await synthesizeGalleryDescriptions(galleries);

  if (synthesized.length === 0) {
    return { count: 0, errors: synthErrors, skipped };
  }

  const embedTexts = synthesized.map((s) => s.embedText);
  const embeddings = await embedDocuments(embedTexts);
  if (embeddings?.error) {
    logger.error('Gallery embedding failed', { error: embeddings.error });
    return { count: 0, errors: synthErrors + synthesized.length, skipped };
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
  return { count, errors, skipped };
}