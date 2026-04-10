/**
 * search_altwire_archive handler.
 * Embeds the query via Voyage AI, runs cosine similarity search over altus_content.
 * Results are recency-weighted and re-sorted before returning.
 */

import pool from '../lib/altus-db.js';
import { embedQuery } from '../lib/voyage.js';
import { applyRecencyWeight } from '../lib/recency.js';
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

  // Over-fetch so recency re-sort can promote recent candidates
  const fetchLimit = Math.min(limit * 3, 60);
  const params = [embeddingStr, fetchLimit];
  if (content_type !== 'all') params.push(content_type);

  const sql = `
    SELECT
      content_type, title, slug, url, published_at, categories, tags,
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

    // Apply recency weighting, re-sort, trim to requested limit
    const weighted = searchResult.rows
      .map((row) => ({
        ...row,
        similarity: parseFloat(row.similarity ?? 0),
        weighted_score: applyRecencyWeight(
          parseFloat(row.similarity ?? 0),
          row.published_at ? new Date(row.published_at).toISOString() : null
        ),
      }))
      .sort((a, b) => b.weighted_score - a.weighted_score)
      .slice(0, limit);

    const results = weighted.map((row) => ({
      type: row.content_type,
      title: row.title,
      slug: row.slug ?? null,
      url: row.url,
      published_at: row.published_at ? new Date(row.published_at).toISOString() : null,
      categories: row.categories ?? [],
      tags: row.tags ?? [],
      snippet: row.snippet ?? '',
      similarity: row.similarity,
      weighted_score: row.weighted_score,
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
