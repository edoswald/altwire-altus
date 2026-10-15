/**
 * scripts/score-reviews.js
 *
 * Scores product/album reviews in the AltWire archive (ratings, pros/cons,
 * copy issues) into the altus_review_scores table. Concert reviews are
 * detected and skipped. Only reviews that are new, edited since their last
 * score, or previously errored are scored, so re-runs are cheap.
 *
 * Usage:
 *   node scripts/score-reviews.js                          # score what needs it (direct calls)
 *   node scripts/score-reviews.js --batch                  # same via the Batch API (50% off, slower)
 *   node scripts/score-reviews.js --limit 20               # newest 20 that need it
 *   node scripts/score-reviews.js --wp-ids 123,456         # only these reviews
 *   node scripts/score-reviews.js --force --wp-ids 123     # rescore even if unchanged
 *   node scripts/score-reviews.js --force --batch          # rescore the whole archive
 *   node scripts/score-reviews.js --export [file]          # write scores as JSON (default review-scores.json)
 *
 * Required env vars:
 *   ALTWIRE_DATABASE_URL (or DATABASE_URL), ANTHROPIC_API_KEY (not for --export)
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import pool from '../lib/altus-db.js';
import { exportScoresAsJson, scorePendingReviews } from '../lib/review-scores.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);

function argValue(name) {
  const idx = args.findIndex((a) => a === name || a.startsWith(`${name}=`));
  if (idx === -1) return undefined;
  const arg = args[idx];
  if (arg.includes('=')) return arg.split('=').slice(1).join('=');
  const next = args[idx + 1];
  return next && !next.startsWith('--') ? next : null;
}

if (!process.env.ALTWIRE_DATABASE_URL && !process.env.DATABASE_URL) {
  console.error('score-reviews: ALTWIRE_DATABASE_URL not set — cannot connect to the archive.');
  process.exit(1);
}

async function main() {
  if (args.includes('--export')) {
    const file = argValue('--export') || path.join(__dirname, '..', 'review-scores.json');
    const output = await exportScoresAsJson();
    await fs.writeFile(file, JSON.stringify(output, null, 2), 'utf8');
    console.log(`Exported ${output.total_processed} scored reviews to ${file}`);
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('score-reviews: ANTHROPIC_API_KEY not set — cannot call Anthropic.');
    process.exit(1);
  }

  const wpIds = (argValue('--wp-ids') ?? '').split(',').map(Number).filter(Boolean);
  const limit = Number(argValue('--limit')) || null;

  const counts = await scorePendingReviews({
    batch: args.includes('--batch'),
    force: args.includes('--force'),
    wpIds: wpIds.length ? wpIds : null,
    limit,
    onProgress: (msg) => console.log(msg),
  });

  console.log('─────────────────────────────────────────────');
  if (!counts.considered) {
    console.log('Nothing to score: every review is up to date. Use --force to rescore.');
  } else {
    console.log(`Reviews considered:      ${counts.considered}`);
    console.log(`Scored:                  ${counts.scored}`);
    console.log(`Concert reviews skipped: ${counts.concert}`);
    console.log(`Errors:                  ${counts.error}`);
  }
}

main()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('score-reviews: Fatal error', err);
    pool.end().finally(() => process.exit(1));
  });
