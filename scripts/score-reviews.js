/**
 * scripts/score-reviews.js
 *
 * Retroactively generates structured ratings, pros/cons, and copy-issue notes
 * for every product/service review in the AltWire corpus (altus_content table).
 * Concert reviews are detected and skipped automatically.
 *
 * Usage:
 *   node scripts/score-reviews.js                          # full run (direct calls)
 *   node scripts/score-reviews.js --batch                  # full run via Anthropic Batch API (50% off)
 *   node scripts/score-reviews.js --wp-ids 123,456,789    # targeted rerun
 *   node scripts/score-reviews.js --force --wp-ids 123    # rerun even if already scored
 *
 * Required env vars:
 *   ALTWIRE_DATABASE_URL  — PostgreSQL connection string
 *   ANTHROPIC_API_KEY     — Anthropic API key
 *
 * Output:
 *   review-scores.json    — Written to project root; updated after every review
 *                           (direct mode) or once at the end (batch mode) for
 *                           crash-safe idempotent re-runs.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import pool from '../lib/altus-db.js';
import {
  buildReviewBatchRequests,
  scoreReview,
  scoreReviewsInBatch,
} from '../lib/review-scoring.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_FILE = path.join(__dirname, '..', 'review-scores.json');

// ---------------------------------------------------------------------------
// Explicit product-type → subcategory map
// The LLM classifies each review's product type from the content itself;
// subcategories are never guessed — they come from this table.
// ---------------------------------------------------------------------------

const PRODUCT_TYPE_SUBCATEGORIES = {
  hardware:    ['Sound', 'Build', 'Workflow', 'Effects', 'Value'],
  software:    ['Sound', 'Interface', 'Workflow', 'Features', 'Value'],
  recording:   ['Sound', 'Build', 'Workflow', 'Features', 'Value'],
  live:        ['Sound', 'Build', 'Reliability', 'Workflow', 'Value'],
  accessory:   ['Build', 'Compatibility', 'Durability', 'Design', 'Value'],
  service:     ['Features', 'Interface', 'Reliability', 'Support', 'Value'],
  album:       ['Sound', 'Production', 'Songwriting', 'Cohesion', 'Value'],
  single:      ['Sound', 'Production', 'Songwriting', 'Impact', 'Value'],
  other:       ['Sound', 'Build', 'Workflow', 'Effects', 'Value'],
};

const PRODUCT_TYPES = Object.keys(PRODUCT_TYPE_SUBCATEGORIES);

// ---------------------------------------------------------------------------
// Env guard
// ---------------------------------------------------------------------------

if (!process.env.ALTWIRE_DATABASE_URL && !process.env.DATABASE_URL) {
  console.error('score-reviews: ALTWIRE_DATABASE_URL not set — cannot connect to corpus.');
  process.exit(1);
}

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('score-reviews: ANTHROPIC_API_KEY not set — cannot call Anthropic.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const forceRerun = args.includes('--force');
const batchMode = args.includes('--batch');

// --wp-ids accepts both forms: --wp-ids=1,2,3 and --wp-ids 1,2,3
const wpIdsIdx = args.findIndex((a) => a === '--wp-ids' || a.startsWith('--wp-ids='));
let targetWpIds = null;
if (wpIdsIdx !== -1) {
  const arg = args[wpIdsIdx];
  const idStr = arg.includes('=') ? arg.split('=').slice(1).join('=') : args[wpIdsIdx + 1];
  const ids = (idStr ?? '').split(',').map(Number).filter(Boolean);
  targetWpIds = ids.length > 0 ? new Set(ids) : null;
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

async function fetchReviews() {
  const { rows } = await pool.query(`
    SELECT id, wp_id, title, url, published_at, categories, tags, raw_text
    FROM altus_content
    WHERE 'Reviews' = ANY(categories)
      AND raw_text IS NOT NULL AND raw_text != ''
    ORDER BY published_at DESC
  `);
  return rows;
}

// ---------------------------------------------------------------------------
// Output file helpers
// ---------------------------------------------------------------------------

async function loadExistingOutput() {
  try {
    const raw = await fs.readFile(OUTPUT_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveOutput(output) {
  await fs.writeFile(OUTPUT_FILE, JSON.stringify(output, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// Per-review result handling (shared by direct and batch modes)
// ---------------------------------------------------------------------------

/**
 * Merge one scored review into the output structure.
 * @param {object} review - corpus row
 * @param {object} result - parsed score-review JSON from the model
 * @param {object} output - the accumulating output document
 * @returns {'scored'|'skipped'|'error'}
 */
function handleScoredReview(review, result, output) {
  if (result.type === 'concert') {
    console.log(`     → Skipped (concert review)\n`);
    output.skipped.push({
      wp_id: review.wp_id,
      title: review.title,
      url: review.url,
      reason: 'concert_review',
    });
    output.total_skipped_concert++;
    return 'skipped';
  }

  if (result.type === 'product') {
    const productType = PRODUCT_TYPES.includes(result.product_type) ? result.product_type : 'other';
    const subcategories = PRODUCT_TYPE_SUBCATEGORIES[productType];

    // Calculate overall rating
    const ratingValues = Object.values(result.ratings ?? {}).filter(Number.isFinite);
    const overall = ratingValues.length > 0
      ? Math.round((ratingValues.reduce((a, b) => a + b, 0) / ratingValues.length) * 10) / 10
      : null;

    console.log(`     → Type: ${productType} | Overall: ${overall} | Pros: ${result.pros?.length ?? 0} | Cons: ${result.cons?.length ?? 0}`);
    if (result.categorization_issue) {
      console.log(`     ⚠ Categorization: ${result.categorization_issue}`);
    }
    console.log();

    output.reviews.push({
      wp_id: review.wp_id,
      title: review.title,
      url: review.url,
      published_at: review.published_at,
      wp_categories: review.categories,
      product_type: productType,
      subcategories,
      ratings: result.ratings,
      overall,
      pros: result.pros ?? [],
      cons: result.cons ?? [],
    });

    output.total_processed++;

    if (result.copy_issues?.length > 0) {
      output.copy_issues.push({
        wp_id: review.wp_id,
        title: review.title,
        url: review.url,
        issues: result.copy_issues,
      });
    }

    if (result.categorization_issue) {
      output.categorization_issues.push({
        wp_id: review.wp_id,
        title: review.title,
        url: review.url,
        wp_categories: review.categories,
        detected_type: productType,
        issue: result.categorization_issue,
      });
    }
    return 'scored';
  }

  console.warn(`     → Unexpected response type: "${result.type}" — recording as error\n`);
  output.errors.push({
    wp_id: review.wp_id,
    title: review.title,
    error: `Unexpected response type: ${result.type}`,
    raw: JSON.stringify(result).slice(0, 200),
  });
  return 'error';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('score-reviews: Starting...\n');
  console.log('Product type → subcategory mappings (explicit):');
  for (const [type, cats] of Object.entries(PRODUCT_TYPE_SUBCATEGORIES)) {
    console.log(`  ${type.padEnd(10)} → ${cats.join(', ')}`);
  }
  console.log();

  if (targetWpIds) {
    console.log(`Targeted rerun mode — wp_ids: ${[...targetWpIds].join(', ')}`);
    if (forceRerun) console.log('--force: will overwrite existing scores for these reviews.');
    console.log();
  }

  // Load existing output for idempotency
  const existing = await loadExistingOutput();

  // In targeted mode with --force, remove those wp_ids from existing results
  // so they get re-scored from scratch.
  if (targetWpIds && forceRerun && existing) {
    existing.reviews = (existing.reviews ?? []).filter((r) => !targetWpIds.has(r.wp_id));
    existing.skipped = (existing.skipped ?? []).filter((r) => !targetWpIds.has(r.wp_id));
    existing.errors  = (existing.errors  ?? []).filter((r) => !targetWpIds.has(r.wp_id));
  }

  const alreadyProcessed = new Set([
    ...(existing?.reviews ?? []).map((r) => r.wp_id),
    ...(existing?.skipped ?? []).map((s) => s.wp_id),
    ...(existing?.errors  ?? []).map((e) => e.wp_id),
  ]);

  if (!targetWpIds && alreadyProcessed.size > 0) {
    console.log(`Resuming — ${alreadyProcessed.size} reviews already processed, will skip.\n`);
  }

  // Fetch candidate reviews (all, or just the targeted subset)
  console.log('Fetching reviews from corpus...');
  const allReviews = await fetchReviews();
  console.log(`Found ${allReviews.length} total entries in Reviews category.\n`);

  if (allReviews.length === 0) {
    console.log('No reviews found. Exiting.');
    await pool.end();
    return;
  }

  // Initialize output structure (merge with existing if resuming)
  const output = {
    generated_at: new Date().toISOString(),
    total_processed: existing?.reviews?.length ?? 0,
    total_skipped_concert: existing?.skipped?.length ?? 0,
    subcategory_mappings: PRODUCT_TYPE_SUBCATEGORIES,
    reviews: existing?.reviews ?? [],
    skipped: existing?.skipped ?? [],
    errors: existing?.errors ?? [],
    copy_issues: existing?.copy_issues ?? [],
    categorization_issues: existing?.categorization_issues ?? [],
  };

  // Filter to only targeted wp_ids if specified; then skip already-processed
  const eligible = targetWpIds
    ? allReviews.filter((r) => targetWpIds.has(r.wp_id))
    : allReviews;

  const toProcess = eligible.filter((r) => !alreadyProcessed.has(r.wp_id));

  if (targetWpIds && toProcess.length === 0) {
    console.log('All targeted reviews already scored. Use --force to overwrite.');
    await pool.end();
    return;
  }

  console.log(`Processing ${toProcess.length} reviews (${eligible.length - toProcess.length} already done)${batchMode ? ' via Anthropic Batch API' : ''}.\n`);

  if (batchMode) {
    // --- Batch mode: one Anthropic Batch API submission (50% discount), ---
    // --- polled to completion, then merged into the output file.        ---
    const requests = buildReviewBatchRequests(toProcess);
    const batchResults = await scoreReviewsInBatch(requests);

    for (let i = 0; i < toProcess.length; i++) {
      const review = toProcess[i];
      console.log(`[${i + 1}/${toProcess.length}] "${review.title}" (wp_id=${review.wp_id})`);
      console.log(`     WP categories: ${(review.categories ?? []).join(', ')}`);

      const outcome = batchResults.get(String(review.wp_id));
      if (!outcome || outcome.error) {
        const error = outcome?.error ?? 'missing batch result';
        console.error(`     → ERROR: ${error}\n`);
        output.errors.push({
          wp_id: review.wp_id,
          title: review.title,
          error,
        });
      } else {
        handleScoredReview(review, outcome.parsed, output);
      }

      output.generated_at = new Date().toISOString();
    }
    await saveOutput(output);
  } else {
    for (let i = 0; i < toProcess.length; i++) {
      const review = toProcess[i];
      const idx = `[${i + 1}/${toProcess.length}]`;

      console.log(`${idx} "${review.title}" (wp_id=${review.wp_id})`);
      console.log(`     WP categories: ${(review.categories ?? []).join(', ')}`);

      try {
        const result = await scoreReview(review);
        handleScoredReview(review, result, output);
      } catch (err) {
        console.error(`     → ERROR: ${err.message}\n`);
        output.errors.push({
          wp_id: review.wp_id,
          title: review.title,
          error: err.message,
        });
      }

      output.generated_at = new Date().toISOString();
      await saveOutput(output);
    }
  }

  // Final summary
  console.log('─────────────────────────────────────────────');
  console.log('Done!');
  console.log(`  Reviews scored:          ${output.total_processed}`);
  console.log(`  Concert reviews skipped: ${output.total_skipped_concert}`);
  console.log(`  Categorization issues:   ${output.categorization_issues.length}`);
  console.log(`  Copy issues found:       ${output.copy_issues.length}`);
  console.log(`  Errors:                  ${output.errors.length}`);
  console.log(`  Output:                  ${OUTPUT_FILE}`);

  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error('score-reviews: Fatal error', err);
  pool.end().finally(() => process.exit(1));
});
