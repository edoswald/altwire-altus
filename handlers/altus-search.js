/**
 * search_altwire_archive handler.
 * Embeds the query via Voyage AI, runs cosine similarity search over altus_content.
 * Results are recency-weighted and re-sorted before returning.
 *
 * Candidates from vector search are reranked with the Voyage reranker (which
 * reads the query and each article's text together, so it is far better at
 * "which of these is actually about X"). If reranking fails, results fall
 * back to vector similarity.
 *
 * Callers that fan out over many queries (e.g. topic discovery) may pass:
 *   embedding      — a precomputed query vector (skips the per-call Voyage call)
 *   totalSearched  — a precomputed archive count (skips the per-call COUNT(*))
 *   rerank: false  — skip reranking (fan-out callers default to no rerank)
 */

import pool, { hasDbConfig } from '../lib/altus-db.js';
import { embedQuery, rerank as rerankDocuments } from '../lib/voyage.js';
import { applyRecencyWeight } from '../lib/recency.js';
import { logger } from '../logger.js';

/**
 * @param {{ query: string, limit: number, content_type: 'post'|'gallery'|'all', embedding?: number[], totalSearched?: number }} params
 * @returns {Promise<object>} results or { error: string }
 */
const RERANK_CANDIDATES = 40;
const RERANK_TEXT_CHARS = 4000;

export async function searchAltwireArchive({ query, limit, content_type, embedding: precomputedEmbedding, totalSearched, rerank }) {
  // Fan-out callers pass a precomputed vector and skip reranking by default.
  const useRerank = rerank ?? !Array.isArray(precomputedEmbedding);
  if (!hasDbConfig()) {
    return { error: 'Database not configured' };
  }

  // Embed here only when the caller did not supply a precomputed vector.
  let vector = precomputedEmbedding;
  if (!Array.isArray(vector)) {
    vector = await embedQuery(query);
    if (vector?.error) {
      return { error: vector.error };
    }
  }

  const embeddingStr = `[${vector.join(',')}]`;
  const typeFilter = content_type === 'all' ? '' : 'AND content_type = $3';

  // Over-fetch so reranking and the recency re-sort can promote candidates
  const fetchLimit = useRerank ? Math.max(RERANK_CANDIDATES, limit) : Math.min(limit * 3, 60);
  const params = [embeddingStr, fetchLimit];
  if (content_type !== 'all') params.push(content_type);

  const sql = `
    SELECT
      content_type, title, slug, url, published_at, categories, tags,
      LEFT(raw_text, 300) AS snippet,
      ${useRerank ? `LEFT(raw_text, ${RERANK_TEXT_CHARS}) AS rerank_text,` : ''}
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
      // Reuse the caller's archive count when provided — avoids a redundant
      // full-table COUNT(*) on every fan-out search.
      totalSearched != null
        ? { rows: [{ count: totalSearched }] }
        : pool.query('SELECT COUNT(*) FROM altus_content WHERE embedding IS NOT NULL'),
    ]);

    let candidates = searchResult.rows.map((row) => ({ ...row, similarity: parseFloat(row.similarity ?? 0) }));
    let reranked = false;
    if (useRerank && candidates.length > 1) {
      const ranking = await rerankDocuments(
        query,
        candidates.map((row) => `${row.title}\n\n${row.rerank_text ?? row.snippet ?? ''}`),
      );
      if (Array.isArray(ranking)) {
        candidates = ranking.map(({ index, relevance_score }) => ({ ...candidates[index], relevance: relevance_score }));
        reranked = true;
      } else {
        logger.warn('Archive search rerank failed; using vector similarity', { error: ranking?.error });
      }
    }

    // Apply recency weighting, re-sort, trim to requested limit
    const weighted = candidates
      .map((row) => ({
        ...row,
        weighted_score: applyRecencyWeight(
          reranked ? row.relevance : row.similarity,
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
      ...(reranked ? { relevance: row.relevance } : {}),
      weighted_score: row.weighted_score,
    }));

    logger.info('Archive search completed', { query, results: results.length, content_type, reranked });

    return {
      results,
      ranking: reranked ? 'reranked' : 'vector_similarity',
      total_searched: parseInt(countResult.rows[0].count, 10),
      query,
    };
  } catch (err) {
    logger.error('Archive search failed', { error: err.message });
    return { error: 'Search failed — database error' };
  }
}
