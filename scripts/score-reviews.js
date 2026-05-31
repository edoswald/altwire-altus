/**
 * scripts/score-reviews.js
 *
 * Retroactively generates structured ratings, pros/cons, and copy-issue notes
 * for every product/service review in the AltWire corpus (altus_content table).
 * Concert reviews are detected and skipped automatically.
 *
 * Usage:
 *   node scripts/score-reviews.js
 *
 * Required env vars:
 *   ALTWIRE_DATABASE_URL  — PostgreSQL connection string
 *   ANTHROPIC_API_KEY     — Anthropic API key
 *
 * Output:
 *   review-scores.json    — Written to project root; updated after every review
 *                           for crash-safe idempotent re-runs.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';
import pool from '../lib/altus-db.js';
import { logger } from '../logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_FILE = path.join(__dirname, '..', 'review-scores.json');
const MODEL = 'claude-haiku-4-5-20251001';
const MAX_PROS_CONS = 5;

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

const anthropic = new Anthropic();

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
// Per-review scoring
// ---------------------------------------------------------------------------

function buildReviewPrompt(review) {
  const bodyText = review.raw_text.length > 6000
    ? review.raw_text.slice(0, 6000) + '\n\n[...truncated for analysis...]'
    : review.raw_text;

  const typeDescriptions = [
    'hardware  — physical music gear: instruments, amps, pedals, synths, drum machines, hardware samplers, etc.',
    'software  — DAWs, plugins, virtual instruments, mobile apps, desktop music software',
    'recording — audio interfaces, studio monitors, microphones, preamps, studio outboard gear',
    'live      — PA systems, live mixing consoles, IEMs, stage monitors, live sound equipment',
    'accessory — cables, cases, strings, picks, straps, stands, tuners, non-electronic accessories',
    'service   — music streaming services, lesson platforms, repair services, software subscriptions',
    'other     — anything that does not clearly fit the above',
  ].join('\n');

  return `You are analyzing an AltWire music publication review article. Read the full text carefully before responding.

TITLE: ${review.title}
WP CATEGORIES: ${(review.categories ?? []).join(', ')}

REVIEW TEXT:
${bodyText}

---

INSTRUCTIONS:

Step 1 — Content classification
Is this a product/service review OR a concert/live performance review?
If it is a concert or live performance review, return ONLY: {"type": "concert"}

Step 2 — Product type (product/service reviews only)
Classify the reviewed item as exactly one of these product types based on the review content — NOT the WP categories:

${typeDescriptions}

Step 3 — Categorization check
If the product type you detected does NOT match what the WP categories suggest, note it briefly.
If the WP categories seem correct or there is no subcategory listed, set categorization_issue to null.

Step 4 — Ratings
Use the subcategories that correspond to the product type you identified:
  hardware:    Sound, Build, Workflow, Effects, Value
  software:    Sound, Interface, Workflow, Features, Value
  recording:   Sound, Build, Workflow, Features, Value
  live:        Sound, Build, Reliability, Workflow, Value
  accessory:   Build, Compatibility, Durability, Design, Value
  service:     Features, Interface, Reliability, Support, Value
  other:       Sound, Build, Workflow, Effects, Value

Rate each subcategory 1–10 based strictly on what the review text says:
  1–5: Poor to mediocre | 6–7: Average to good | 8–9: Great | 10: Exceptional

Step 5 — Pros and cons
Extract pros and cons ONLY from points explicitly made in the review text. Do not invent.
HARD LIMIT: maximum ${MAX_PROS_CONS} pros and maximum ${MAX_PROS_CONS} cons.
Fewer is better for short reviews — do not pad. Aim for quality, not quantity.
Balance the count to reflect the overall tone:
  avg ≥ 8.0 → more pros than cons
  avg 6.0–7.9 → roughly balanced (within 1)
  avg ≤ 5.9 → more cons than pros

Step 6 — Copy issues
Note any clear spelling errors, grammatical mistakes, or formatting problems. Be brief and specific.
Return an empty array if none found.

---

Return ONLY a valid JSON object, no markdown fences, no explanation outside the JSON:

{
  "type": "product",
  "product_type": "<one of: hardware|software|recording|live|accessory|service|other>",
  "categorization_issue": "<string describing mismatch, or null>",
  "pros": ["...", ...],
  "cons": ["...", ...],
  "ratings": {
    "<subcategory1>": <1-10>,
    "<subcategory2>": <1-10>,
    "<subcategory3>": <1-10>,
    "<subcategory4>": <1-10>,
    "<subcategory5>": <1-10>
  },
  "copy_issues": ["...", ...]
}`;
}

function capArray(arr, max) {
  return Array.isArray(arr) ? arr.slice(0, max) : [];
}

async function scoreReview(review) {
  const prompt = buildReviewPrompt(review);

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1500,
    messages: [{ role: 'user', content: prompt }],
  });

  const raw = response.content?.[0]?.text ?? '{}';
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON object found in response');
  const result = JSON.parse(match[0]);

  // Enforce hard cap on pros/cons regardless of what the model returned
  if (result.pros) result.pros = capArray(result.pros, MAX_PROS_CONS);
  if (result.cons) result.cons = capArray(result.cons, MAX_PROS_CONS);

  return result;
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

  // Load existing output for idempotency
  const existing = await loadExistingOutput();
  const alreadyProcessed = new Set([
    ...(existing?.reviews ?? []).map((r) => r.wp_id),
    ...(existing?.skipped ?? []).map((s) => s.wp_id),
    ...(existing?.errors ?? []).map((e) => e.wp_id),
  ]);

  if (alreadyProcessed.size > 0) {
    console.log(`Resuming — ${alreadyProcessed.size} reviews already processed, will skip.\n`);
  }

  // Fetch all candidate reviews
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

  const toProcess = allReviews.filter((r) => !alreadyProcessed.has(r.wp_id));
  console.log(`Processing ${toProcess.length} new reviews (${allReviews.length - toProcess.length} already done).\n`);

  for (let i = 0; i < toProcess.length; i++) {
    const review = toProcess[i];
    const idx = `[${i + 1}/${toProcess.length}]`;

    console.log(`${idx} "${review.title}" (wp_id=${review.wp_id})`);
    console.log(`     WP categories: ${(review.categories ?? []).join(', ')}`);

    try {
      const result = await scoreReview(review);

      if (result.type === 'concert') {
        console.log(`     → Skipped (concert review)\n`);
        output.skipped.push({
          wp_id: review.wp_id,
          title: review.title,
          url: review.url,
          reason: 'concert_review',
        });
        output.total_skipped_concert++;
      } else if (result.type === 'product') {
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
      } else {
        console.warn(`     → Unexpected response type: "${result.type}" — recording as error\n`);
        output.errors.push({
          wp_id: review.wp_id,
          title: review.title,
          error: `Unexpected response type: ${result.type}`,
          raw: JSON.stringify(result).slice(0, 200),
        });
      }
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
