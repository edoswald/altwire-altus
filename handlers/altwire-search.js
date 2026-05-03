/**
 * search_altwire public search handler.
 * Embeds the query via Voyage AI (voyage-3-lite), runs cosine similarity
 * search over altus_content, synthesizes an answer via MiniMax-2.7.
 *
 * Input:  { query: string, limit?: number }
 * Output: { answer: string, citations: ArticleRef[], results: SearchResult[] }
 */

import pool from '../lib/altus-db.js';
import { embedQuery } from '../lib/voyage.js';
import { synthesizeSearchAnswer } from '../lib/minimax-search.js';
import { logger } from '../logger.js';

const DEFAULT_LIMIT = 10;
const MIN_SCORE = parseFloat(process.env.ALTWIRE_SEARCH_MIN_SCORE || '0.70');

/**
 * @param {{ query: string, limit?: number }} params
 * @returns {Promise<object>}
 */
export async function searchAltwirePublic({ query, limit }) {
  if (!query || !query.trim()) {
    return { error: 'Query is required', answer: '', citations: [], results: [] };
  }

  if (!process.env.DATABASE_URL) {
    return { error: 'Database not configured', answer: '', citations: [], results: [] };
  }

  const actualLimit = Math.min(Math.max(1, parseInt(limit, 10) || DEFAULT_LIMIT), 20);

  const embedding = await embedQuery(query);
  if (embedding?.error) {
    logger.error('Public search embedding failed', { error: embedding.error, query });
    return { error: embedding.error, answer: '', citations: [], results: [] };
  }

  const embeddingStr = `[${embedding.join(',')}]`;

  const sql = `
    SELECT
      id, wp_id, content_type, title, slug, url, author,
      categories, tags,
      LEFT(raw_text, 300) AS snippet,
      1 - (embedding <=> $1::vector) AS similarity
    FROM altus_content
    WHERE content_type = 'post'
      AND embedding IS NOT NULL
      AND 1 - (embedding <=> $1::vector) > $2
    ORDER BY embedding <=> $1::vector
    LIMIT $3
  `;

  let dbRows;
  try {
    const result = await pool.query(sql, [embeddingStr, MIN_SCORE, actualLimit]);
    dbRows = result.rows;
  } catch (err) {
    logger.error('Public search DB query failed', { error: err.message, query });
    return { error: 'Search failed — database error', answer: '', citations: [], results: [] };
  }

  const results = dbRows.map((row) => ({
    title: row.title,
    url: row.url,
    excerpt: row.snippet || '',
    score: parseFloat(row.similarity ?? 0),
  }));

  const synthesisResult = await synthesizeSearchAnswer(query, results);

  await logSearchQuery({
    query,
    mode: 'ai',
    resultCount: results.length,
    responseTimeMs: 0,
  });

  logger.info('Public search completed', {
    query,
    results: results.length,
    synthesisModel: synthesisResult.model,
  });

  return {
    answer: synthesisResult.answer,
    citations: synthesisResult.citations,
    results,
  };
}

/**
 * Log a search query to altus_search_queries for analytics.
 * @param {{ query: string, mode: string, resultCount: number, responseTimeMs: number }} params
 */
async function logSearchQuery({ query, mode, resultCount, responseTimeMs }) {
  try {
    await pool.query(
      `INSERT INTO altus_search_queries (query, mode, result_count, response_time_ms)
       VALUES ($1, $2, $3, $4)`,
      [query.trim(), mode, resultCount, responseTimeMs]
    );
  } catch (err) {
    logger.warn('Search query log failed', { error: err.message });
  }
}

/**
 * Retrieve search feedback for review during beta.
 * @param {{ rating?: number, since?: string, limit?: number }} params
 * @returns {Promise<object>}
 */
export async function getSearchFeedback({ rating, since, limit = 50 }) {
  if (!process.env.DATABASE_URL) {
    return { error: 'Database not configured', feedback: [] };
  }

  const conditions = [];
  const values = [];
  let idx = 1;

  if (rating !== undefined) {
    conditions.push(`rating = $${idx++}`);
    values.push(rating);
  }
  if (since) {
    conditions.push(`created_at > $${idx++}`);
    values.push(since);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  values.push(Math.min(Math.max(1, parseInt(limit, 10) || 50), 200));

  try {
    const result = await pool.query(
      `SELECT id, query, mode, rating, comment, answer_excerpt, results_shown,
              ip_address, user_agent, created_at
       FROM altus_search_feedback
       ${where}
       ORDER BY created_at DESC
       LIMIT $${idx}`,
      values
    );
    return { feedback: result.rows, count: result.rows.length };
  } catch (err) {
    logger.error('getSearchFeedback query failed', { error: err.message });
    return { error: 'Failed to retrieve feedback', feedback: [] };
  }
}