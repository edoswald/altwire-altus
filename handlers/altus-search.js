/**
 * search_altwire_archive handler.
 * Embeds the query via Voyage AI, runs cosine similarity search over altus_content.
 */

import pool from '../lib/altus-db.js';
import { embedQuery } from '../lib/voyage.js';
import { logger } from '../logger.js';

/**
 * @param {{ query: string, limit: number, content_type: 'post'|'gallery'|'all' }} params
 * @returns {Promise<object>} results or { error: string }
 */
export async function searchAltwareArchive({ query, limit, content_type }) {
  if (!process.env.DATABASE_URL) {
    return { error: 'Database not configured' };
  }

  const embedding = await embedQuery(query);
  if (embedding?.error) {
    return { error: embedding.error };
  }

  const embeddingStr = `[${embedding.join(',')}]`;
  const typeFilter = content_type === 'all' ? '' : 'AND content_type = $3';
  const params = [embeddingStr, limit];
  if (content_type !== 'all') params.push(content_type);

  const sql = `
    SELECT
      content_type, title, url, published_at, categories, tags,
      LEFT(raw_text, 300) AS snippet,
      1 - (embedding <=> $1::vector) AS similarity
    FROM altus_content
    WHERE embedding IS NOT NULL
    ${typeFilter}
    ORDER BY embedding <=> $1::vector
    LIMIT $2
  `;

  try {
    const [searchResult, countResult] = await Promise.all([
      pool.query(sql, params),
      pool.query('SELECT COUNT(*) FROM altus_content WHERE embedding IS NOT NULL'),
    ]);

    const results = searchResult.rows.map((row) => ({
      type: row.content_type,
      title: row.title,
      url: row.url,
      published_at: row.published_at ? new Date(row.published_at).toISOString() : null,
      categories: row.categories ?? [],
      tags: row.tags ?? [],
      snippet: row.snippet ?? '',
      similarity: parseFloat(row.similarity ?? 0),
    }));

    logger.info('Archive search completed', { query, results: results.length, content_type });

    return {
      results,
      total_searched: parseInt(countResult.rows[0].count, 10),
      query,
    };
  } catch (err) {
    logger.error('Archive search failed', { error: err.message });
    return { error: 'Search failed — database error' };
  }
}
