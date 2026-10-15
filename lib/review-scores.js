/**
 * Review scores in Postgres (altus_review_scores).
 *
 * Every product/album review in the archive (altus_content, 'Reviews'
 * category) gets a structured score from lib/review-scoring.js: product type,
 * 1–10 subcategory ratings, an overall average, and pros/cons. A review is
 * scored again only when its text changes (content_hash), so the nightly
 * ingest can call scorePendingReviews() cheaply.
 *
 * Read side: findGiftGuideCandidates() powers the find_gift_guide_candidates
 * tool (best-rated reviewed products for gift guides and roundups).
 */

import pool from './altus-db.js';
import { logger } from '../logger.js';
import {
  MODEL,
  buildReviewBatchRequests,
  scoreReview,
  scoreReviewsInBatch,
} from './review-scoring.js';

export const PRODUCT_TYPE_SUBCATEGORIES = {
  hardware:  ['Sound', 'Build', 'Workflow', 'Effects', 'Value'],
  software:  ['Sound', 'Interface', 'Workflow', 'Features', 'Value'],
  recording: ['Sound', 'Build', 'Workflow', 'Features', 'Value'],
  live:      ['Sound', 'Build', 'Reliability', 'Workflow', 'Value'],
  accessory: ['Build', 'Compatibility', 'Durability', 'Design', 'Value'],
  service:   ['Features', 'Interface', 'Reliability', 'Support', 'Value'],
  album:     ['Sound', 'Production', 'Songwriting', 'Cohesion', 'Value'],
  single:    ['Sound', 'Production', 'Songwriting', 'Impact', 'Value'],
  other:     ['Sound', 'Build', 'Workflow', 'Effects', 'Value'],
};

export const PRODUCT_TYPES = Object.keys(PRODUCT_TYPE_SUBCATEGORIES);

export async function ensureReviewScoresTable(client = pool) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS altus_review_scores (
      wp_id                INTEGER PRIMARY KEY,
      content_hash         TEXT NOT NULL,
      status               TEXT NOT NULL CHECK (status IN ('scored', 'concert', 'error')),
      product_type         TEXT,
      ratings              JSONB,
      overall              NUMERIC(3,1),
      pros                 JSONB NOT NULL DEFAULT '[]'::jsonb,
      cons                 JSONB NOT NULL DEFAULT '[]'::jsonb,
      copy_issues          JSONB NOT NULL DEFAULT '[]'::jsonb,
      categorization_issue TEXT,
      error                TEXT,
      model                TEXT,
      scored_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS altus_review_scores_type_idx
      ON altus_review_scores (product_type, overall DESC)
      WHERE status = 'scored'
  `);
}

/**
 * Turn a model result (or an error) into a row for altus_review_scores.
 * Pure; exported for tests.
 */
export function buildScoreRow(review, result, error = null) {
  const base = {
    wp_id: review.wp_id,
    content_hash: review.content_hash,
    product_type: null,
    ratings: null,
    overall: null,
    pros: [],
    cons: [],
    copy_issues: [],
    categorization_issue: null,
    error: null,
    model: MODEL,
  };
  if (error || !result) return { ...base, status: 'error', error: String(error ?? 'no result') };
  if (result.type === 'concert') return { ...base, status: 'concert' };
  if (result.type !== 'product') {
    return { ...base, status: 'error', error: `Unexpected response type: ${result.type}` };
  }

  const productType = PRODUCT_TYPES.includes(result.product_type) ? result.product_type : 'other';
  const ratings = {};
  for (const [name, value] of Object.entries(result.ratings ?? {})) {
    const n = Number(value);
    if (Number.isFinite(n)) ratings[name] = Math.min(10, Math.max(1, Math.round(n)));
  }
  const values = Object.values(ratings);
  const overall = values.length
    ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10
    : null;

  return {
    ...base,
    status: 'scored',
    product_type: productType,
    ratings,
    overall,
    pros: Array.isArray(result.pros) ? result.pros : [],
    cons: Array.isArray(result.cons) ? result.cons : [],
    copy_issues: Array.isArray(result.copy_issues) ? result.copy_issues : [],
    categorization_issue: result.categorization_issue || null,
  };
}

export async function saveScoreRow(row) {
  await pool.query(
    `INSERT INTO altus_review_scores
       (wp_id, content_hash, status, product_type, ratings, overall, pros, cons,
        copy_issues, categorization_issue, error, model, scored_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
     ON CONFLICT (wp_id) DO UPDATE SET
       content_hash = EXCLUDED.content_hash,
       status = EXCLUDED.status,
       product_type = EXCLUDED.product_type,
       ratings = EXCLUDED.ratings,
       overall = EXCLUDED.overall,
       pros = EXCLUDED.pros,
       cons = EXCLUDED.cons,
       copy_issues = EXCLUDED.copy_issues,
       categorization_issue = EXCLUDED.categorization_issue,
       error = EXCLUDED.error,
       model = EXCLUDED.model,
       scored_at = NOW()`,
    [
      row.wp_id,
      row.content_hash,
      row.status,
      row.product_type,
      row.ratings == null ? null : JSON.stringify(row.ratings),
      row.overall,
      JSON.stringify(row.pros),
      JSON.stringify(row.cons),
      JSON.stringify(row.copy_issues),
      row.categorization_issue,
      row.error,
      row.model,
    ],
  );
}

/**
 * Reviews that need a (re)score: never scored, text changed since the last
 * score, or a previous attempt errored. `force` rescores everything in scope.
 */
export async function fetchReviewsToScore({ wpIds = null, force = false, limit = null } = {}) {
  const params = [];
  const where = [
    `'Reviews' = ANY(c.categories)`,
    `c.raw_text IS NOT NULL AND c.raw_text <> ''`,
  ];
  if (wpIds?.length) {
    params.push(wpIds);
    where.push(`c.wp_id = ANY($${params.length})`);
  }
  if (!force) {
    where.push(`(s.wp_id IS NULL OR s.content_hash <> md5(c.raw_text) OR s.status = 'error')`);
  }
  let sql = `
    SELECT DISTINCT ON (c.wp_id)
           c.wp_id, c.title, c.url, c.published_at, c.categories, c.raw_text,
           md5(c.raw_text) AS content_hash
      FROM altus_content c
      LEFT JOIN altus_review_scores s ON s.wp_id = c.wp_id
     WHERE ${where.join(' AND ')}
     ORDER BY c.wp_id, c.published_at DESC NULLS LAST`;
  // Newest reviews first, so a capped run covers recent coverage.
  sql = `SELECT * FROM (${sql}) r ORDER BY r.published_at DESC NULLS LAST`;
  if (limit) {
    params.push(limit);
    sql += ` LIMIT $${params.length}`;
  }
  const { rows } = await pool.query(sql, params);
  return rows;
}

function tally(counts, row) {
  counts[row.status] = (counts[row.status] ?? 0) + 1;
}

/**
 * Score the reviews that need it and store the results.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.batch=false]   Use the Batch API (50% off; can take up to an hour).
 * @param {number[]} [opts.wpIds]        Only these reviews.
 * @param {boolean} [opts.force=false]   Rescore even unchanged reviews.
 * @param {number} [opts.limit]          Cap on reviews scored this run (newest first).
 * @param {(msg: string) => void} [opts.onProgress]
 * @returns {Promise<{ considered: number, scored: number, concert: number, error: number }>}
 */
export async function scorePendingReviews({ batch = false, wpIds = null, force = false, limit = null, onProgress = () => {} } = {}) {
  await ensureReviewScoresTable();
  const reviews = await fetchReviewsToScore({ wpIds, force, limit });
  const counts = { considered: reviews.length, scored: 0, concert: 0, error: 0 };
  if (!reviews.length) return counts;

  onProgress(`Scoring ${reviews.length} review(s)${batch ? ' via the Batch API' : ''}`);

  if (batch) {
    const results = await scoreReviewsInBatch(buildReviewBatchRequests(reviews));
    for (const review of reviews) {
      const outcome = results.get(String(review.wp_id));
      const row = buildScoreRow(review, outcome?.parsed, outcome ? outcome.error : 'missing batch result');
      await saveScoreRow(row);
      tally(counts, row);
    }
  } else {
    for (const [i, review] of reviews.entries()) {
      let row;
      try {
        row = buildScoreRow(review, await scoreReview(review));
      } catch (err) {
        row = buildScoreRow(review, null, err.message);
      }
      await saveScoreRow(row);
      tally(counts, row);
      onProgress(`[${i + 1}/${reviews.length}] ${row.status.padEnd(7)} ${review.title}`);
    }
  }

  logger.info('Review scoring run complete', counts);
  return counts;
}

/** All scored rows, in the shape the old review-scores.json used (for the analysis scripts). */
export async function exportScoresAsJson() {
  const { rows } = await pool.query(`
    SELECT s.*, c.title, c.url, c.published_at, c.categories
      FROM altus_review_scores s
      JOIN LATERAL (
        SELECT title, url, published_at, categories FROM altus_content
         WHERE wp_id = s.wp_id ORDER BY published_at DESC NULLS LAST LIMIT 1
      ) c ON TRUE
     ORDER BY c.published_at DESC NULLS LAST`);
  const pick = (r) => ({ wp_id: r.wp_id, title: r.title, url: r.url });
  const scored = rows.filter((r) => r.status === 'scored');
  return {
    generated_at: new Date().toISOString(),
    total_processed: scored.length,
    total_skipped_concert: rows.filter((r) => r.status === 'concert').length,
    subcategory_mappings: PRODUCT_TYPE_SUBCATEGORIES,
    reviews: scored.map((r) => ({
      ...pick(r),
      published_at: r.published_at,
      wp_categories: r.categories,
      product_type: r.product_type,
      subcategories: PRODUCT_TYPE_SUBCATEGORIES[r.product_type] ?? [],
      ratings: r.ratings,
      overall: r.overall == null ? null : Number(r.overall),
      pros: r.pros,
      cons: r.cons,
    })),
    skipped: rows.filter((r) => r.status === 'concert').map((r) => ({ ...pick(r), reason: 'concert_review' })),
    errors: rows.filter((r) => r.status === 'error').map((r) => ({ ...pick(r), error: r.error })),
    copy_issues: scored.filter((r) => r.copy_issues?.length).map((r) => ({ ...pick(r), issues: r.copy_issues })),
    categorization_issues: scored.filter((r) => r.categorization_issue).map((r) => ({
      ...pick(r), wp_categories: r.categories, detected_type: r.product_type, issue: r.categorization_issue,
    })),
  };
}

/**
 * Best-rated reviewed products for gift guides and roundups.
 *
 * @param {object} opts
 * @param {string[]} [opts.product_types]
 * @param {number} [opts.min_overall]
 * @param {string} [opts.min_rating_subcategory]  e.g. 'Value'
 * @param {number} [opts.min_rating_value]
 * @param {string} [opts.published_after]         YYYY-MM-DD
 * @param {string} [opts.published_before]        YYYY-MM-DD
 * @param {string} [opts.title_contains]
 * @param {number} [opts.limit=25]
 */
export async function findGiftGuideCandidates(opts = {}) {
  const {
    product_types: productTypes,
    min_overall: minOverall,
    min_rating_subcategory: subcategory,
    min_rating_value: subcategoryMin,
    published_after: after,
    published_before: before,
    title_contains: titleContains,
    limit = 25,
  } = opts;

  await ensureReviewScoresTable();

  const params = [];
  const add = (value) => { params.push(value); return `$${params.length}`; };
  const where = [`s.status = 'scored'`];
  if (productTypes?.length) where.push(`s.product_type = ANY(${add(productTypes)})`);
  if (minOverall != null) where.push(`s.overall >= ${add(minOverall)}`);
  if (subcategory && subcategoryMin != null) {
    // Ratings keys are capitalized subcategory names (Sound, Value, …).
    const key = subcategory.trim().replace(/^\w/, (ch) => ch.toUpperCase());
    where.push(`(s.ratings ->> ${add(key)})::numeric >= ${add(subcategoryMin)}`);
  }
  if (after) where.push(`c.published_at >= ${add(after)}::date`);
  if (before) where.push(`c.published_at < (${add(before)}::date + 1)`);
  if (titleContains) where.push(`c.title ILIKE ${add(`%${titleContains}%`)}`);

  const { rows } = await pool.query(
    `SELECT c.title, c.url, c.published_at, c.categories, s.product_type, s.overall,
            s.ratings, s.pros, s.cons, s.scored_at
       FROM altus_review_scores s
       JOIN LATERAL (
         SELECT title, url, published_at, categories FROM altus_content
          WHERE wp_id = s.wp_id ORDER BY published_at DESC NULLS LAST LIMIT 1
       ) c ON TRUE
      WHERE ${where.join(' AND ')}
      ORDER BY s.overall DESC NULLS LAST, c.published_at DESC NULLS LAST
      LIMIT ${add(Math.min(Math.max(Number(limit) || 25, 1), 100))}`,
    params,
  );

  const { rows: [coverage] } = await pool.query(`
    SELECT
      (SELECT COUNT(DISTINCT wp_id) FROM altus_content
        WHERE 'Reviews' = ANY(categories) AND raw_text IS NOT NULL AND raw_text <> '')::int AS reviews_in_archive,
      COUNT(*) FILTER (WHERE status = 'scored')::int AS scored,
      COUNT(*) FILTER (WHERE status = 'concert')::int AS concert_reviews_skipped,
      MAX(scored_at) AS last_scored_at
    FROM altus_review_scores`);

  return {
    candidates: rows.map((r) => ({
      title: r.title,
      url: r.url,
      published_at: r.published_at,
      product_type: r.product_type,
      overall: r.overall == null ? null : Number(r.overall),
      ratings: r.ratings,
      pros: (r.pros ?? []).slice(0, 3),
      cons: (r.cons ?? []).slice(0, 2),
    })),
    count: rows.length,
    coverage,
    note: 'Ratings are inferred from the review text (1–10), not scores the writer published. No prices are stored; check current prices before publishing.',
  };
}
