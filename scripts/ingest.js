/**
 * AltWire content ingestion script.
 *
 * Run once (or on-demand) to populate altus_content with embeddings:
 *   node scripts/ingest.js
 *
 * Re-runs are safe — ON CONFLICT DO UPDATE ensures idempotency.
 */

import { initSchema, upsertContent, logIngestRun } from '../lib/altus-db.js';
import { fetchTaxonomies, fetchPosts, fetchGalleries } from '../lib/wp-client.js';
import { embedDocuments } from '../lib/voyage.js';
import { synthesizeGallery } from '../lib/synthesizer.js';
import { logger } from '../logger.js';

const required = ['DATABASE_URL', 'ALTWIRE_WP_URL', 'ALTWIRE_WP_USER', 'ALTWIRE_WP_APP_PASSWORD', 'VOYAGE_API_KEY', 'ANTHROPIC_API_KEY'];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing required env var: ${key}`);
    process.exit(1);
  }
}

const startTime = Date.now();
let postsIngested = 0;
let galleriesIngested = 0;
let errors = 0;

async function ingestPosts(caches) {
  logger.info('Fetching posts from WordPress...');
  const posts = await fetchPosts(caches);
  logger.info(`Fetched ${posts.length} posts — embedding in batches of 50...`);

  // Build embed texts
  const embedTexts = posts.map((p) => {
    const cats = p.categories.join(', ');
    const tags = p.tags.join(', ');
    return `${p.title}\n\n${cats}\n${tags}\n\n${p.raw_text}`.slice(0, 3000);
  });

  const embeddings = await embedDocuments(embedTexts);
  if (embeddings?.error) {
    logger.error('Post embedding failed', { error: embeddings.error });
    errors += posts.length;
    return;
  }

  for (let i = 0; i < posts.length; i++) {
    try {
      await upsertContent({ ...posts[i], embedding: embeddings[i] });
      postsIngested++;
    } catch (err) {
      logger.warn('Post upsert failed', { wp_id: posts[i].wp_id, error: err.message });
      errors++;
    }
  }
  logger.info(`Posts ingested: ${postsIngested}`);
}

async function ingestGalleries() {
  logger.info('Fetching galleries from WordPress...');
  const galleries = await fetchGalleries();
  logger.info(`Fetched ${galleries.length} galleries — synthesizing...`);

  // Synthesize all galleries first (Claude calls), then batch-embed together
  const synthesized = [];
  for (const gallery of galleries) {
    try {
      const synthesis = await synthesizeGallery(gallery);
      const tags = (gallery.tags ?? []).join(', ');
      const embedText = `${gallery.title}\n\nPhoto gallery\n${tags}\n\n${synthesis}`.slice(0, 8000);
      synthesized.push({ gallery, synthesis, embedText });
    } catch (err) {
      logger.warn('Gallery synthesis failed', { id: gallery.id, error: err.message });
      errors++;
    }
  }

  logger.info(`Synthesized ${synthesized.length} galleries — embedding in batches...`);
  const embedTexts = synthesized.map((s) => s.embedText);
  const embeddings = await embedDocuments(embedTexts);
  if (embeddings?.error) {
    logger.error('Gallery embedding failed', { error: embeddings.error });
    errors += synthesized.length;
    return;
  }

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
      galleriesIngested++;
    } catch (err) {
      logger.warn('Gallery upsert failed', { id: gallery.id, error: err.message });
      errors++;
    }
  }
  logger.info(`Galleries ingested: ${galleriesIngested}`);
}

async function main() {
  logger.info('Starting Altus ingestion run...');

  await initSchema();

  const caches = await fetchTaxonomies();

  await ingestPosts(caches);
  await ingestGalleries();

  const durationMs = Date.now() - startTime;
  await logIngestRun({
    mode: 'full',
    postsIngested,
    galleriesIngested,
    errors,
    durationMs,
    notes: `Ingestion complete. Posts: ${postsIngested}, Galleries: ${galleriesIngested}, Errors: ${errors}`,
  });

  console.log(`\nIngestion complete in ${(durationMs / 1000).toFixed(1)}s`);
  console.log(`  Posts:     ${postsIngested}`);
  console.log(`  Galleries: ${galleriesIngested}`);
  console.log(`  Errors:    ${errors}`);
  process.exit(errors > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal ingest error:', err.message);
  process.exit(1);
});
