/**
 * scripts/analyze-review-scores.js
 *
 * Prints a distribution analysis of review-scores.json to help determine
 * badge thresholds (Editor's Choice, Recommended/Top Pick).
 *
 * Usage:
 *   node scripts/analyze-review-scores.js
 *   node scripts/analyze-review-scores.js path/to/review-scores.json
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const filePath = process.argv[2] ?? path.join(__dirname, '..', 'review-scores.json');

const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
const reviews = data.reviews ?? [];

if (reviews.length === 0) {
  console.log('No reviews found in file.');
  process.exit(0);
}

const overalls = reviews.map((r) => r.overall).filter((v) => v != null).sort((a, b) => a - b);
const n = overalls.length;

const mean = overalls.reduce((a, b) => a + b, 0) / n;
const median = n % 2 === 0
  ? (overalls[n / 2 - 1] + overalls[n / 2]) / 2
  : overalls[Math.floor(n / 2)];
const min = overalls[0];
const max = overalls[n - 1];

// Percentile helper
function pct(p) {
  const idx = Math.ceil((p / 100) * n) - 1;
  return overalls[Math.max(0, Math.min(n - 1, idx))];
}

const p10 = pct(10);
const p25 = pct(25);
const p50 = pct(50);
const p75 = pct(75);
const p85 = pct(85);
const p90 = pct(90);
const p95 = pct(95);

// Bucket distribution
const buckets = {};
for (let i = 1; i <= 10; i++) buckets[i] = 0;
for (const v of overalls) {
  const bucket = Math.min(10, Math.ceil(v));
  buckets[bucket]++;
}

// Product type breakdown
const byType = {};
for (const r of reviews) {
  const t = r.product_type ?? 'unknown';
  if (!byType[t]) byType[t] = [];
  byType[t].push(r.overall);
}

console.log('='.repeat(56));
console.log(' AltWire Review Score Distribution');
console.log('='.repeat(56));
console.log(`\n  Total reviews scored: ${n}`);
console.log(`  Min:    ${min.toFixed(1)}   Max:    ${max.toFixed(1)}`);
console.log(`  Mean:   ${mean.toFixed(2)}  Median: ${median.toFixed(1)}`);

console.log('\n--- Percentiles ----------------------------------------');
console.log(`  P10: ${p10.toFixed(1)}  P25: ${p25.toFixed(1)}  P50: ${p50.toFixed(1)}`);
console.log(`  P75: ${p75.toFixed(1)}  P85: ${p85.toFixed(1)}  P90: ${p90.toFixed(1)}  P95: ${p95.toFixed(1)}`);

console.log('\n--- Score bucket distribution ---------------------------');
const barMax = Math.max(...Object.values(buckets));
for (let i = 1; i <= 10; i++) {
  const count = buckets[i] ?? 0;
  const bar = '█'.repeat(Math.round((count / barMax) * 30));
  const pctStr = ((count / n) * 100).toFixed(1).padStart(5);
  console.log(`  ${i.toString().padStart(2)}  ${bar.padEnd(30)}  ${count.toString().padStart(3)} (${pctStr}%)`);
}

console.log('\n--- By product type -------------------------------------');
for (const [type, vals] of Object.entries(byType).sort((a, b) => b[1].length - a[1].length)) {
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  const lo = Math.min(...vals).toFixed(1);
  const hi = Math.max(...vals).toFixed(1);
  console.log(`  ${type.padEnd(12)} n=${vals.length.toString().padStart(3)}  avg=${avg.toFixed(1)}  range ${lo}–${hi}`);
}

// Badge threshold suggestions
console.log('\n--- Badge threshold candidates --------------------------');
const candidates = [7.0, 7.5, 7.8, 8.0, 8.2, 8.5, 9.0];
for (const threshold of candidates) {
  const count = overalls.filter((v) => v >= threshold).length;
  const share = ((count / n) * 100).toFixed(1);
  console.log(`  ≥ ${threshold.toFixed(1)} → ${count.toString().padStart(3)} reviews (${share.padStart(5)}%)`);
}

console.log('\n--- Top 10 scores ---------------------------------------');
const top10 = [...reviews]
  .filter((r) => r.overall != null)
  .sort((a, b) => b.overall - a.overall)
  .slice(0, 10);
for (const r of top10) {
  console.log(`  ${r.overall.toFixed(1)}  ${r.title}`);
}

console.log('\n--- Bottom 10 scores ------------------------------------');
const bottom10 = [...reviews]
  .filter((r) => r.overall != null)
  .sort((a, b) => a.overall - b.overall)
  .slice(0, 10);
for (const r of bottom10) {
  console.log(`  ${r.overall.toFixed(1)}  ${r.title}`);
}

console.log('\n' + '='.repeat(56));
