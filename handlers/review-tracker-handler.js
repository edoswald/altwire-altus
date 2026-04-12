/**
 * review-tracker-handler.js
 *
 * Review assignment tracking, loaner item management, and structured
 * review note-taking with AI auto-categorization.
 */

import pool from '../lib/altus-db.js';
import { logAiUsage } from '../lib/ai-cost-tracker.js';
import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../logger.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const VALID_REVIEW_STATUSES = [
  'assigned', 'in_progress', 'submitted', 'editing', 'scheduled', 'published', 'cancelled',
];

export const VALID_LOANER_STATUSES = ['out', 'kept', 'returned', 'overdue', 'lost'];

export const VALID_NOTE_CATEGORIES = ['pro', 'con', 'observation', 'uncategorized'];

const anthropic = new Anthropic(); // uses ANTHROPIC_API_KEY from env

// ---------------------------------------------------------------------------
// Schema initialization
// ---------------------------------------------------------------------------

/**
 * Creates altus_reviews, altus_loaners, and altus_review_notes tables
 * with CHECK constraints, indexes, and foreign keys.
 * Safe to run on every deploy (all DDL uses IF NOT EXISTS).
 */
export async function initReviewTrackerSchema() {
  // -- altus_reviews
  await pool.query(`
    CREATE TABLE IF NOT EXISTS altus_reviews (
      id            SERIAL PRIMARY KEY,
      title         TEXT NOT NULL,
      product       TEXT,
      reviewer      TEXT NOT NULL DEFAULT 'Derek',
      status        TEXT NOT NULL DEFAULT 'assigned'
                    CHECK (status IN ('assigned','in_progress','submitted','editing','scheduled','published','cancelled')),
      due_date      DATE,
      assigned_date DATE DEFAULT CURRENT_DATE,
      wp_post_id    INTEGER,
      notes         TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS altus_reviews_status_idx ON altus_reviews (status)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS altus_reviews_due_date_idx ON altus_reviews (due_date)`);

  // -- altus_loaners
  await pool.query(`
    CREATE TABLE IF NOT EXISTS altus_loaners (
      id                   SERIAL PRIMARY KEY,
      item_name            TEXT NOT NULL,
      brand                TEXT,
      borrower             TEXT NOT NULL DEFAULT 'Derek',
      is_loaner            BOOLEAN NOT NULL DEFAULT true,
      status               TEXT NOT NULL DEFAULT 'out'
                           CHECK (status IN ('out','kept','returned','overdue','lost')),
      loaned_date          DATE DEFAULT CURRENT_DATE,
      expected_return_date DATE,
      actual_return_date   DATE,
      review_id            INTEGER REFERENCES altus_reviews(id) ON DELETE SET NULL,
      notes                TEXT,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS altus_loaners_status_idx ON altus_loaners (status)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS altus_loaners_return_date_idx ON altus_loaners (expected_return_date)`);

  // -- altus_review_notes
  await pool.query(`
    CREATE TABLE IF NOT EXISTS altus_review_notes (
      id         SERIAL PRIMARY KEY,
      review_id  INTEGER NOT NULL REFERENCES altus_reviews(id) ON DELETE CASCADE,
      note_text  TEXT NOT NULL,
      category   TEXT NOT NULL DEFAULT 'uncategorized'
                 CHECK (category IN ('pro','con','observation','uncategorized')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS altus_review_notes_review_idx ON altus_review_notes (review_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS altus_review_notes_category_idx ON altus_review_notes (category)`);

  logger.info('Review tracker schema initialized');
}

// ---------------------------------------------------------------------------
// Helpers (not exported)
// ---------------------------------------------------------------------------

/**
 * Converts PostgreSQL DATE columns (returned as JS Date objects by pg driver)
 * to ISO YYYY-MM-DD strings for consistent API responses.
 */
function formatDates(row) {
  const dateFields = ['due_date', 'assigned_date', 'loaned_date', 'expected_return_date', 'actual_return_date'];
  for (const field of dateFields) {
    if (row[field] instanceof Date) {
      row[field] = row[field].toISOString().slice(0, 10);
    }
  }
  return row;
}

/**
 * Classifies a review note as pro, con, or observation using Claude Haiku.
 * Returns 'uncategorized' on any failure — never blocks note creation.
 */
async function autoCategorizNote(noteText) {
  const CLASSIFIABLE = ['pro', 'con', 'observation'];
  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 10,
      system: 'You are a music gear review classifier. Respond with exactly one word: pro, con, or observation.',
      messages: [{ role: 'user', content: `Classify this review note about a music product: "${noteText}"` }],
    });
    const raw = response.content?.[0]?.text?.trim().toLowerCase();
    const category = CLASSIFIABLE.includes(raw) ? raw : 'uncategorized';
    return { category, model: response.model, usage: response.usage };
  } catch (err) {
    logger.error('Auto-categorization failed', { error: err.message });
    return { category: 'uncategorized', model: 'claude-haiku-4-5-20251001', usage: { input_tokens: 0, output_tokens: 0 } };
  }
}

// ---------------------------------------------------------------------------
// Review functions
// ---------------------------------------------------------------------------

/**
 * Creates a new review assignment.
 * Defaults: reviewer='Derek', status='assigned'.
 */
export async function createReview({ title, product, reviewer, status, due_date, wp_post_id, notes }) {
  const r = reviewer || 'Derek';
  const s = status || 'assigned';

  const { rows } = await pool.query(
    `INSERT INTO altus_reviews (title, product, reviewer, status, due_date, wp_post_id, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [title, product || null, r, s, due_date || null, wp_post_id || null, notes || null],
  );

  return { review: formatDates(rows[0]) };
}

/**
 * Retrieves a single review by ID.
 */
export async function getReview({ review_id }) {
  const { rows } = await pool.query(
    `SELECT * FROM altus_reviews WHERE id = $1`,
    [review_id],
  );

  if (rows.length === 0) {
    return { error: 'review_not_found', review_id };
  }

  return { review: formatDates(rows[0]) };
}

/**
 * Updates a review. Only fields that are provided (not undefined) are updated.
 * Always sets updated_at = NOW().
 */
export async function updateReview({ review_id, title, product, reviewer, status, due_date, wp_post_id, notes }) {
  if (status !== undefined && !VALID_REVIEW_STATUSES.includes(status)) {
    return { error: 'invalid_status', status, valid: VALID_REVIEW_STATUSES };
  }

  const fields = [];
  const values = [];
  let idx = 1;

  if (title !== undefined)      { fields.push(`title = $${idx++}`);      values.push(title); }
  if (product !== undefined)    { fields.push(`product = $${idx++}`);    values.push(product); }
  if (reviewer !== undefined)   { fields.push(`reviewer = $${idx++}`);   values.push(reviewer); }
  if (status !== undefined)     { fields.push(`status = $${idx++}`);     values.push(status); }
  if (due_date !== undefined)   { fields.push(`due_date = $${idx++}`);   values.push(due_date); }
  if (wp_post_id !== undefined) { fields.push(`wp_post_id = $${idx++}`); values.push(wp_post_id); }
  if (notes !== undefined)      { fields.push(`notes = $${idx++}`);      values.push(notes); }

  fields.push('updated_at = NOW()');

  const { rows } = await pool.query(
    `UPDATE altus_reviews SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
    [...values, review_id],
  );

  if (rows.length === 0) return { error: 'review_not_found', review_id };
  return { review: formatDates(rows[0]) };
}

export async function listReviews({ status, reviewer } = {}) {
  const conditions = [];
  const values = [];
  let idx = 1;

  if (status !== undefined) { conditions.push(`status = $${idx++}`); values.push(status); }
  if (reviewer !== undefined) { conditions.push(`reviewer = $${idx++}`); values.push(reviewer); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT * FROM altus_reviews ${where} ORDER BY due_date ASC NULLS LAST`,
    values,
  );

  return { reviews: rows.map(formatDates), count: rows.length };
}

export async function getUpcomingReviewDeadlines({ days = 7 } = {}) {
  const { rows } = await pool.query(
    `SELECT * FROM altus_reviews
     WHERE due_date IS NOT NULL
       AND due_date <= CURRENT_DATE + $1 * INTERVAL '1 day'
       AND status NOT IN ('published', 'cancelled')
     ORDER BY due_date ASC`,
    [days],
  );

  if (rows.length === 0) {
    return { reviews: [], count: 0, note: `No review deadlines in the next ${days} days` };
  }
  return { reviews: rows.map(formatDates), count: rows.length };
}

// ---------------------------------------------------------------------------
// Loaner functions
// ---------------------------------------------------------------------------

export async function logLoaner({ item_name, brand, borrower, is_loaner, expected_return_date, review_id, notes }) {
  const b = borrower || 'Derek';
  const isLoan = is_loaner !== false; // default true
  const status = isLoan ? 'out' : 'kept';
  const returnDate = isLoan ? (expected_return_date || null) : null;

  const { rows } = await pool.query(
    `INSERT INTO altus_loaners (item_name, brand, borrower, is_loaner, status, expected_return_date, review_id, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [item_name, brand || null, b, isLoan, status, returnDate, review_id || null, notes || null],
  );

  return { loaner: formatDates(rows[0]) };
}

export async function getLoaner({ loaner_id }) {
  const { rows } = await pool.query(
    `SELECT * FROM altus_loaners WHERE id = $1`,
    [loaner_id],
  );

  if (rows.length === 0) return { error: 'loaner_not_found', loaner_id };
  return { loaner: formatDates(rows[0]) };
}

/**
 * Updates a loaner. Only fields that are provided (not undefined) are updated.
 * Business rules applied before building query:
 *   - is_loaner=false → status='kept', expected_return_date=NULL
 *   - status='returned' without actual_return_date → auto-set to CURRENT_DATE
 * Always sets updated_at = NOW().
 */
export async function updateLoaner({ loaner_id, item_name, brand, borrower, is_loaner, status, expected_return_date, actual_return_date, review_id, notes }) {
  // Apply business rules before building query
  if (is_loaner === false) {
    status = 'kept';
    expected_return_date = null;
  }

  if (status !== undefined && !VALID_LOANER_STATUSES.includes(status)) {
    return { error: 'invalid_status', status, valid: VALID_LOANER_STATUSES };
  }

  const fields = [];
  const values = [];
  let idx = 1;

  if (item_name !== undefined)            { fields.push(`item_name = $${idx++}`);            values.push(item_name); }
  if (brand !== undefined)                { fields.push(`brand = $${idx++}`);                values.push(brand); }
  if (borrower !== undefined)             { fields.push(`borrower = $${idx++}`);             values.push(borrower); }
  if (is_loaner !== undefined)            { fields.push(`is_loaner = $${idx++}`);            values.push(is_loaner); }
  if (status !== undefined)               { fields.push(`status = $${idx++}`);               values.push(status); }
  if (expected_return_date !== undefined)  { fields.push(`expected_return_date = $${idx++}`); values.push(expected_return_date); }
  if (review_id !== undefined)            { fields.push(`review_id = $${idx++}`);            values.push(review_id); }
  if (notes !== undefined)                { fields.push(`notes = $${idx++}`);                values.push(notes); }

  // Auto-set actual_return_date when marking as returned
  if (status === 'returned' && actual_return_date === undefined) {
    fields.push(`actual_return_date = CURRENT_DATE`);
  } else if (actual_return_date !== undefined) {
    fields.push(`actual_return_date = $${idx++}`);
    values.push(actual_return_date);
  }

  fields.push('updated_at = NOW()');

  const { rows } = await pool.query(
    `UPDATE altus_loaners SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
    [...values, loaner_id],
  );

  if (rows.length === 0) return { error: 'loaner_not_found', loaner_id };
  return { loaner: formatDates(rows[0]) };
}

export async function listLoaners({ status, borrower } = {}) {
  const conditions = [];
  const values = [];
  let idx = 1;

  if (status !== undefined) { conditions.push(`status = $${idx++}`); values.push(status); }
  if (borrower !== undefined) { conditions.push(`borrower = $${idx++}`); values.push(borrower); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT * FROM altus_loaners ${where} ORDER BY loaned_date DESC`,
    values,
  );

  return { loaners: rows.map(formatDates), count: rows.length };
}

export async function getOverdueLoaners() {
  const { rows } = await pool.query(
    `SELECT * FROM altus_loaners
     WHERE expected_return_date < CURRENT_DATE
       AND actual_return_date IS NULL
       AND status NOT IN ('returned', 'kept', 'lost')
     ORDER BY expected_return_date ASC`,
  );

  if (rows.length === 0) return { loaners: [], count: 0, note: 'No overdue loaners' };
  return { loaners: rows.map(formatDates), count: rows.length };
}

export async function getUpcomingLoanerReturns({ days = 14 } = {}) {
  const { rows } = await pool.query(
    `SELECT * FROM altus_loaners
     WHERE expected_return_date IS NOT NULL
       AND expected_return_date <= CURRENT_DATE + $1 * INTERVAL '1 day'
       AND expected_return_date >= CURRENT_DATE
       AND actual_return_date IS NULL
       AND status NOT IN ('kept', 'lost')
     ORDER BY expected_return_date ASC`,
    [days],
  );

  if (rows.length === 0) {
    return { loaners: [], count: 0, note: `No loaner returns due in the next ${days} days` };
  }
  return { loaners: rows.map(formatDates), count: rows.length };
}

// ---------------------------------------------------------------------------
// Review note functions
// ---------------------------------------------------------------------------

export async function addReviewNote({ review_id, note_text, category }) {
  // Verify review exists
  const { rows: reviewRows } = await pool.query(
    'SELECT id FROM altus_reviews WHERE id = $1',
    [review_id],
  );
  if (reviewRows.length === 0) return { error: 'review_not_found', review_id };

  // Auto-categorize if no category provided
  let finalCategory = category;
  if (finalCategory === undefined) {
    const catResult = await autoCategorizNote(note_text);
    finalCategory = catResult.category;
    await logAiUsage('altus_add_review_note', catResult.model, catResult.usage);
  }

  const { rows } = await pool.query(
    `INSERT INTO altus_review_notes (review_id, note_text, category)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [review_id, note_text, finalCategory],
  );

  return { note: rows[0] };
}

export async function updateReviewNote({ note_id, note_text, category }) {
  if (category !== undefined && !VALID_NOTE_CATEGORIES.includes(category)) {
    return { error: 'invalid_category', category, valid: VALID_NOTE_CATEGORIES };
  }

  const fields = [];
  const values = [];
  let idx = 1;

  if (note_text !== undefined) { fields.push(`note_text = $${idx++}`); values.push(note_text); }
  if (category !== undefined)  { fields.push(`category = $${idx++}`);  values.push(category); }

  fields.push('updated_at = NOW()');

  const { rows } = await pool.query(
    `UPDATE altus_review_notes SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
    [...values, note_id],
  );

  if (rows.length === 0) return { error: 'note_not_found', note_id };
  return { note: rows[0] };
}

export async function listReviewNotes({ review_id, category } = {}) {
  const values = [review_id];
  let query = 'SELECT * FROM altus_review_notes WHERE review_id = $1';

  if (category !== undefined) {
    query += ' AND category = $2';
    values.push(category);
  }

  query += ' ORDER BY created_at ASC';

  const { rows } = await pool.query(query, values);
  return { notes: rows, count: rows.length };
}

export async function deleteReviewNote({ note_id }) {
  const { rowCount } = await pool.query(
    'DELETE FROM altus_review_notes WHERE id = $1',
    [note_id],
  );

  if (rowCount === 0) return { error: 'note_not_found', note_id };
  return { deleted: true, note_id };
}

// ---------------------------------------------------------------------------
// Editorial digest
// ---------------------------------------------------------------------------

export async function getEditorialDigest() {
  const [pipelineResult, deadlinesResult, overdueReviewsResult, loanerSummaryResult, overdueLoanersResult, returningResult] = await Promise.all([
    // Review pipeline counts (exclude published/cancelled from active count)
    pool.query(`
      SELECT status, COUNT(*)::int AS count
      FROM altus_reviews
      WHERE status NOT IN ('published', 'cancelled')
      GROUP BY status
    `),
    // Upcoming review deadlines (next 7 days)
    pool.query(`
      SELECT * FROM altus_reviews
      WHERE due_date IS NOT NULL
        AND due_date <= CURRENT_DATE + INTERVAL '7 days'
        AND due_date >= CURRENT_DATE
        AND status NOT IN ('published', 'cancelled')
      ORDER BY due_date ASC
    `),
    // Overdue reviews
    pool.query(`
      SELECT * FROM altus_reviews
      WHERE due_date IS NOT NULL
        AND due_date < CURRENT_DATE
        AND status NOT IN ('published', 'cancelled')
      ORDER BY due_date ASC
    `),
    // Loaner summary counts
    pool.query(`
      SELECT status, COUNT(*)::int AS count
      FROM altus_loaners
      GROUP BY status
    `),
    // Overdue loaners
    pool.query(`
      SELECT * FROM altus_loaners
      WHERE expected_return_date < CURRENT_DATE
        AND actual_return_date IS NULL
        AND status NOT IN ('returned', 'kept', 'lost')
      ORDER BY expected_return_date ASC
    `),
    // Loaners returning this week
    pool.query(`
      SELECT * FROM altus_loaners
      WHERE expected_return_date IS NOT NULL
        AND expected_return_date <= CURRENT_DATE + INTERVAL '7 days'
        AND expected_return_date >= CURRENT_DATE
        AND actual_return_date IS NULL
        AND status NOT IN ('kept', 'lost')
      ORDER BY expected_return_date ASC
    `),
  ]);

  // Build pipeline object
  const review_pipeline = {};
  for (const s of VALID_REVIEW_STATUSES.filter(s => !['published', 'cancelled'].includes(s))) {
    review_pipeline[s] = 0;
  }
  for (const row of pipelineResult.rows) {
    review_pipeline[row.status] = row.count;
  }

  // Build loaner summary object
  const loaner_summary = {};
  for (const s of VALID_LOANER_STATUSES) {
    loaner_summary[s] = 0;
  }
  for (const row of loanerSummaryResult.rows) {
    loaner_summary[row.status] = row.count;
  }

  return {
    review_pipeline,
    upcoming_deadlines: deadlinesResult.rows.map(formatDates),
    overdue_reviews: overdueReviewsResult.rows.map(formatDates),
    loaner_summary,
    overdue_loaners: overdueLoanersResult.rows.map(formatDates),
    returning_this_week: returningResult.rows.map(formatDates),
    generated_at: new Date().toISOString(),
  };
}
