/**
 * scripts/merge-review-scores.js
 *
 * Merges gear reviews from review-scores-v2.json with the fresh album/single
 * scores from review-scores.json into review-scores-merged.json.
 *
 * Usage:
 *   node scripts/merge-review-scores.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const v2     = JSON.parse(fs.readFileSync(path.join(root, 'review-scores-v2.json'), 'utf8'));
const albums = JSON.parse(fs.readFileSync(path.join(root, 'review-scores.json'),    'utf8'));

// Album/single wp_ids from the fresh rerun
const rerunIds = new Set(albums.reviews.map((r) => r.wp_id));

// Keep only gear reviews from v2 (exclude anything rerun)
const gearReviews = v2.reviews.filter((r) => !rerunIds.has(r.wp_id));

const merged = {
  generated_at: new Date().toISOString(),
  total_processed: gearReviews.length + albums.reviews.length,
  total_skipped_concert: (v2.skipped?.length ?? 0) + (albums.skipped?.length ?? 0),
  subcategory_mappings: albums.subcategory_mappings,
  reviews: [...gearReviews, ...albums.reviews],
  skipped: [...(v2.skipped ?? []), ...(albums.skipped ?? [])],
  errors: [...(v2.errors ?? []), ...(albums.errors ?? [])],
  copy_issues: [...(v2.copy_issues ?? []), ...(albums.copy_issues ?? [])],
  categorization_issues: [...(v2.categorization_issues ?? []), ...(albums.categorization_issues ?? [])],
};

fs.writeFileSync(path.join(root, 'review-scores-merged.json'), JSON.stringify(merged, null, 2));

console.log('Gear reviews:         ', gearReviews.length);
console.log('Album/single reviews: ', albums.reviews.length);
console.log('Total merged:         ', merged.total_processed);
console.log('Written to:            review-scores-merged.json');
