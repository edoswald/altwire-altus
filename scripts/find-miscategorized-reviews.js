/**
 * scripts/find-miscategorized-reviews.js
 *
 * Scans review-scores.json to identify reviews that are likely album, single,
 * EP, or other music-release reviews being scored with gear subcategories.
 * Outputs a list of wp_ids and WordPress edit URLs for quick re-categorization.
 *
 * Also flags the 0.0 anomaly and any other structural oddities.
 *
 * Usage:
 *   node scripts/find-miscategorized-reviews.js
 *   node scripts/find-miscategorized-reviews.js path/to/review-scores.json
 *
 * Output:
 *   Prints to console AND writes miscategorized-reviews.json to project root.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const filePath = process.argv[2] ?? path.join(__dirname, '..', 'review-scores.json');
const outputPath = path.join(__dirname, '..', 'miscategorized-reviews.json');

// WP base URL for edit links — adjust if needed
const WP_BASE = process.env.ALTWIRE_WP_URL?.replace(/\/$/, '') ?? 'https://altwire.net';

const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
const reviews = data.reviews ?? [];

// ---------------------------------------------------------------------------
// Detection patterns
// ---------------------------------------------------------------------------

// Title patterns that strongly suggest a music release review
const RELEASE_TITLE_PATTERNS = [
  /\[album review\]/i,
  /\balb(um)?\s+review\b/i,
  /\bsingle review\b/i,
  /\bep review\b/i,
  /\b(track|song) review\b/i,
  /\brecord review\b/i,
  /\b– review\b/i,          // "Artist – Album Title review"
];

// WP categories that indicate a music release (not gear)
const RELEASE_CATEGORY_PATTERNS = [
  /album/i,
  /single/i,
  /\bep\b/i,
  /music review/i,
  /record review/i,
  /release/i,
];

// Gear/product subcategory labels — if these were applied to a release review
// that's the mismatch we're looking for
const GEAR_SUBCATEGORIES = new Set([
  'Build', 'Workflow', 'Effects', 'Interface', 'Features',
  'Reliability', 'Compatibility', 'Durability', 'Design', 'Support',
]);

function isLikelyRelease(review) {
  const titleMatch = RELEASE_TITLE_PATTERNS.some((p) => p.test(review.title));
  const catMatch = (review.wp_categories ?? review.categories ?? [])
    .some((c) => RELEASE_CATEGORY_PATTERNS.some((p) => p.test(c)));
  // If subcategories include gear-specific labels AND title hints at a release
  const subcatMismatch = (review.subcategories ?? []).some((s) => GEAR_SUBCATEGORIES.has(s))
    && (titleMatch || catMatch);
  return titleMatch || catMatch || subcatMismatch;
}

function isAnomaly(review) {
  return review.overall === 0 || review.overall === null || review.overall === undefined;
}

// ---------------------------------------------------------------------------
// Classify
// ---------------------------------------------------------------------------

const miscat = [];
const anomalies = [];
const clean = [];

for (const r of reviews) {
  if (isAnomaly(r)) {
    anomalies.push(r);
  } else if (isLikelyRelease(r)) {
    miscat.push(r);
  } else {
    clean.push(r);
  }
}

// ---------------------------------------------------------------------------
// Suggested correct subcategories for music release reviews
// ---------------------------------------------------------------------------

const SUGGESTED_RELEASE_SUBCATEGORIES = ['Sound', 'Production', 'Songwriting', 'Cohesion', 'Value'];

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

console.log('='.repeat(60));
console.log(' AltWire Miscategorized Review Report');
console.log('='.repeat(60));
console.log(`\n  Total reviews:         ${reviews.length}`);
console.log(`  Likely miscategorized: ${miscat.length}`);
console.log(`  Score anomalies (0/null): ${anomalies.length}`);
console.log(`  Appear clean:          ${clean.length}`);

if (anomalies.length > 0) {
  console.log('\n─── Score Anomalies (0.0 or null overall) ──────────────');
  for (const r of anomalies) {
    console.log(`  wp_id ${r.wp_id}  overall=${r.overall}`);
    console.log(`    Title: ${r.title}`);
    console.log(`    Edit:  ${WP_BASE}/wp-admin/post.php?post=${r.wp_id}&action=edit`);
  }
}

console.log('\n─── Likely Music Release Reviews (wrong subcategories) ──');
console.log(`  Suggested subcategories for these: ${SUGGESTED_RELEASE_SUBCATEGORIES.join(', ')}\n`);

for (const r of miscat) {
  const cats = (r.wp_categories ?? r.categories ?? []).join(', ');
  const subs = (r.subcategories ?? []).join(', ');
  console.log(`  wp_id ${String(r.wp_id).padEnd(6)}  overall=${String(r.overall ?? '?').padEnd(4)}  ${r.title}`);
  console.log(`    WP categories: ${cats || '(none)'}`);
  console.log(`    Subcategories used: ${subs}`);
  console.log(`    Edit: ${WP_BASE}/wp-admin/post.php?post=${r.wp_id}&action=edit`);
  console.log();
}

// ---------------------------------------------------------------------------
// Write output JSON for use with score-reviews.js --wp-ids
// ---------------------------------------------------------------------------

const wpIdsToRerun = [...miscat, ...anomalies].map((r) => r.wp_id);

const outputData = {
  generated_at: new Date().toISOString(),
  source_file: filePath,
  suggested_subcategories_for_releases: SUGGESTED_RELEASE_SUBCATEGORIES,
  miscategorized: miscat.map((r) => ({
    wp_id: r.wp_id,
    title: r.title,
    overall: r.overall,
    wp_categories: r.wp_categories ?? r.categories ?? [],
    subcategories_used: r.subcategories ?? [],
    wp_edit_url: `${WP_BASE}/wp-admin/post.php?post=${r.wp_id}&action=edit`,
  })),
  anomalies: anomalies.map((r) => ({
    wp_id: r.wp_id,
    title: r.title,
    overall: r.overall,
    wp_edit_url: `${WP_BASE}/wp-admin/post.php?post=${r.wp_id}&action=edit`,
  })),
  rerun_wp_ids: wpIdsToRerun,
};

fs.writeFileSync(outputPath, JSON.stringify(outputData, null, 2));

console.log('─── Rerun command (after fixing WP categories) ──────────');
console.log(`\n  node scripts/score-reviews.js --wp-ids ${wpIdsToRerun.join(',')}\n`);
console.log(`  Full list also saved to: miscategorized-reviews.json`);
console.log('='.repeat(60));
