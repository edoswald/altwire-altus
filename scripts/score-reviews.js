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

const DEFAULT_SUBCATEGORIES = ['Sound', 'Build', 'Workflow', 'Effects', 'Value'];
const GENERIC_CATEGORIES = new Set(['Reviews', 'Featured', 'Uncategorized', 'Editor\'s Picks']);

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

const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY from env

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
// Subcategory mapping (Phase 2)
// ---------------------------------------------------------------------------

function extractSubcategory(categories) {
  return (categories ?? []).find((c) => !GENERIC_CATEGORIES.has(c)) ?? null;
}

async function determineSubcategoryMappings(reviews) {
  // Collect unique subcategories with a representative title each
  const subcatMap = new Map(); // subcategory -> first review title seen
  for (const review of reviews) {
    const sub = extractSubcategory(review.categories);
    if (sub && !subcatMap.has(sub)) {
      subcatMap.set(sub, review.title);
    }
  }

  if (subcatMap.size === 0) {
    console.log('No subcategories found — using defaults for all reviews.');
    return {};
  }

  const subcategoryList = [...subcatMap.entries()]
    .map(([name, title]) => `- "${name}" (example: "${title}")`)
    .join('\n');

  console.log(`Determining subcategory mappings for: ${[...subcatMap.keys()].join(', ')}`);

  const prompt = `You are helping map AltWire review categories to a 5-point rating rubric.

Default subcategories: Sound, Build, Workflow, Effects, Value
These are designed for music hardware gear reviews (guitars, amps, pedals, etc.)

For each review subcategory below, decide whether the default set fits reasonably well.
If the default set does NOT fit (e.g. a software plugin review doesn't have a physical "Build"),
provide 5 replacement subcategory names that make better sense for that content type.

Return JSON only — an object where each key is the subcategory name and each value is an array of exactly 5 strings.
Use the default set when it fits. Only replace when the defaults genuinely don't apply.

Review subcategories to evaluate:
${subcategoryList}

Example output:
{
  "Gear Reviews": ["Sound", "Build", "Workflow", "Effects", "Value"],
  "Plugin Reviews": ["Sound", "Interface", "Workflow", "Features", "Value"]
}`;

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });

  const raw = response.content?.[0]?.text ?? '{}';
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : {};
  } catch {
    console.warn('Failed to parse subcategory mapping response — using defaults for all.');
    return {};
  }
}

// ---------------------------------------------------------------------------
// Per-review scoring (Phase 3)
// ---------------------------------------------------------------------------

function buildReviewPrompt(review, subcategories) {
  const subList = subcategories.join(', ');
  // Truncate very long reviews to keep token cost reasonable; 4000 chars is ~1000 tokens
  const bodyText = review.raw_text.length > 6000
    ? review.raw_text.slice(0, 6000) + '\n\n[...truncated for analysis...]'
    : review.raw_text;

  return `You are analyzing an AltWire music publication review article.

TITLE: ${review.title}
CATEGORIES: ${(review.categories ?? []).join(', ')}

REVIEW TEXT:
${bodyText}

---

TASK:

Step 1 — Classify: Is this a product/service review (gear, software, hardware, services) OR a concert/live performance review?
If it is a concert/live performance review, return ONLY: {"type": "concert"}

Step 2 — If product/service review, analyze and return JSON with this exact structure:

{
  "type": "product",
  "pros": ["string", ...],
  "cons": ["string", ...],
  "ratings": {
    "${subcategories[0]}": <integer 1-10>,
    "${subcategories[1]}": <integer 1-10>,
    "${subcategories[2]}": <integer 1-10>,
    "${subcategories[3]}": <integer 1-10>,
    "${subcategories[4]}": <integer 1-10>
  },
  "copy_issues": ["string", ...]
}

RATING GUIDELINES:
- Rating subcategories to use: ${subList}
- 1-5: Poor to mediocre | 6-7: Average to good | 8-9: Great | 10: Exceptional
- Base ratings strictly on what the review text says, not external knowledge

PROS/CONS GUIDELINES:
- Extract pros and cons ONLY from what is mentioned in the review text
- Quantity should reflect the overall sentiment:
  - Overall avg ≥ 8.0: significantly more pros than cons (at least 2:1)
  - Overall avg 6.0–7.9: roughly balanced (within 1 of each other)
  - Overall avg ≤ 5.9: more cons than pros
- If the review is short or thin, fewer items is fine — don't pad

COPY ISSUES GUIDELINES:
- Note any clear spelling errors, grammatical mistakes, or formatting problems you notice
- Be brief and specific (e.g. "Possible misspelling: 'distrotion'")
- Return an empty array if no issues found

Return JSON only, no markdown, no explanation outside the JSON.`;
}

async function scoreReview(review, subcategories) {
  const prompt = buildReviewPrompt(review, subcategories);

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1500,
    messages: [{ role: 'user', content: prompt }],
  });

  const raw = response.content?.[0]?.text ?? '{}';
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON object found in response');
  return JSON.parse(match[0]);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('score-reviews: Starting...\n');

  // Load existing output for idempotency
  const existing = await loadExistingOutput();
  const alreadyProcessed = new Set(
    (existing?.reviews ?? []).map((r) => r.wp_id)
      .concat((existing?.skipped ?? []).map((s) => s.wp_id))
      .concat((existing?.errors ?? []).map((e) => e.wp_id))
  );

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

  // Determine subcategory mappings (always recalculate — cheap)
  const subcategoryMappings = await determineSubcategoryMappings(allReviews);
  console.log('\nSubcategory mappings determined:');
  for (const [sub, cats] of Object.entries(subcategoryMappings)) {
    console.log(`  ${sub}: ${cats.join(', ')}`);
  }
  console.log();

  // Initialize output structure (merge with existing if resuming)
  const output = {
    generated_at: new Date().toISOString(),
    total_processed: existing?.reviews?.length ?? 0,
    total_skipped_concert: existing?.skipped?.length ?? 0,
    subcategory_mappings: subcategoryMappings,
    reviews: existing?.reviews ?? [],
    skipped: existing?.skipped ?? [],
    errors: existing?.errors ?? [],
    copy_issues: existing?.copy_issues ?? [],
  };

  const toProcess = allReviews.filter((r) => !alreadyProcessed.has(r.wp_id));
  console.log(`Processing ${toProcess.length} new reviews (${allReviews.length - toProcess.length} already done).\n`);

  for (let i = 0; i < toProcess.length; i++) {
    const review = toProcess[i];
    const idx = `[${i + 1}/${toProcess.length}]`;

    // Determine subcategories for this review
    const subcategory = extractSubcategory(review.categories);
    const subcategories = (subcategory && subcategoryMappings[subcategory])
      ? subcategoryMappings[subcategory]
      : DEFAULT_SUBCATEGORIES;

    console.log(`${idx} Processing: "${review.title}" (wp_id=${review.wp_id})`);
    console.log(`     Categories: ${(review.categories ?? []).join(', ')}`);
    console.log(`     Subcategories: ${subcategories.join(', ')}`);

    try {
      const result = await scoreReview(review, subcategories);

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
        // Calculate overall rating
        const ratingValues = Object.values(result.ratings ?? {}).filter(Number.isFinite);
        const overall = ratingValues.length > 0
          ? Math.round((ratingValues.reduce((a, b) => a + b, 0) / ratingValues.length) * 10) / 10
          : null;

        console.log(`     → Overall: ${overall} | Pros: ${result.pros?.length ?? 0} | Cons: ${result.cons?.length ?? 0}\n`);

        output.reviews.push({
          wp_id: review.wp_id,
          title: review.title,
          url: review.url,
          published_at: review.published_at,
          categories: review.categories,
          subcategories,
          ratings: result.ratings,
          overall,
          pros: result.pros ?? [],
          cons: result.cons ?? [],
        });

        output.total_processed++;

        // Record any copy issues separately
        if (result.copy_issues?.length > 0) {
          output.copy_issues.push({
            wp_id: review.wp_id,
            title: review.title,
            url: review.url,
            issues: result.copy_issues,
          });
          console.log(`     Copy issues noted: ${result.copy_issues.length}`);
        }
      } else {
        // Unexpected response shape
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

    // Write after every review — crash-safe
    output.generated_at = new Date().toISOString();
    await saveOutput(output);
  }

  // Final summary
  console.log('─────────────────────────────────────────────');
  console.log(`Done!`);
  console.log(`  Reviews scored:      ${output.total_processed}`);
  console.log(`  Concert reviews:     ${output.total_skipped_concert}`);
  console.log(`  Errors:              ${output.errors.length}`);
  console.log(`  Copy issues found:   ${output.copy_issues.length}`);
  console.log(`  Output:              ${OUTPUT_FILE}`);

  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error('score-reviews: Fatal error', err);
  pool.end().finally(() => process.exit(1));
});
