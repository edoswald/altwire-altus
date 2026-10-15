/**
 * search_altwire_archive handler.
 * Embeds the query via Voyage AI, runs cosine similarity search over altus_content.
 * Results are recency-weighted and re-sorted before returning.
 *
 * Hybrid retrieval: semantic (vector) matches plus keyword (Postgres
 * full-text) matches, so exact names (bands, products, people) are found even
 * when embeddings blur them. The combined candidates are reranked with the
 * Voyage reranker (which
 * reads the query and each article's text together, so it is far better at
 * "which of these is actually about X"). If reranking fails, results fall
 * back to reciprocal-rank fusion of the two lists.
 *
 * Callers that fan out over many queries (e.g. topic discovery) may pass:
 *   embedding      — a precomputed query vector (skips the per-call Voyage call)
 *   totalSearched  — a precomputed archive count (skips the per-call COUNT(*))
 *   rerank: false  — vector-only, no keyword search or reranking (fan-out
 *                    callers with a precomputed embedding default to this)
 */

import pool, { hasDbConfig } from '../lib/altus-db.js';
import { embedQuery, rerank as rerankDocuments } from '../lib/voyage.js';
import { applyRecencyWeight } from '../lib/recency.js';
import { logger } from '../logger.js';

const RERANK_CANDIDATES = 40;
const KEYWORD_CANDIDATES = 20;
const RERANK_TEXT_CHARS = 4000;
const RRF_K = 60;

/**
 * Merge semantic and keyword candidate lists by row id, recording each row's
 * rank in either list and a reciprocal-rank-fusion score normalized to 0-1.
 * Exported for tests.
 */
export function fuseCandidates(vectorRows, keywordRows) {
  const byId = new Map();
  const add = (rows, rankKey) => rows.forEach((row, i) => {
    const key = row.id ?? row.url ?? `${rankKey}:${i}`;
    const existing = byId.get(key) ?? { ...row };
    existing[rankKey] = i + 1;
    if (row.keyword_rank != null) existing.keyword_rank = row.keyword_rank;
    byId.set(key, existing);
  });
  add(vectorRows, 'vector_position');
  add(keywordRows, 'keyword_position');

  const maxRrf = 2 / (RRF_K + 1);
  return [...byId.values()].map((row) => {
    const rrf = (row.vector_position ? 1 / (RRF_K + row.vector_position) : 0)
      + (row.keyword_position ? 1 / (RRF_K + row.keyword_position) : 0);
    const match = row.vector_position && row.keyword_position ? 'both' : (row.keyword_position ? 'keyword' : 'semantic');
    return { ...row, similarity: parseFloat(row.similarity ?? 0), fused: rrf / maxRrf, match };
  });
}

/**
 * @param {{ query: string, limit: number, content_type: 'post'|'gallery'|'all', embedding?: number[], totalSearched?: number, rerank?: boolean }} params
 * @returns {Promise<object>} results or { error: string }
 */
export async function searchAltwireArchive({ query, limit, content_type, embedding: precomputedEmbedding, totalSearched, rerank }) {
  // Fan-out callers pass a precomputed vector and get plain vector search.
  const hybrid = rerank ?? !Array.isArray(precomputedEmbedding);
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
  const columns = `
      id, content_type, title, slug, url, published_at, categories, tags,
      LEFT(raw_text, 300) AS snippet,
      ${hybrid ? `LEFT(raw_text, ${RERANK_TEXT_CHARS}) AS rerank_text,` : ''}
      1 - (embedding <=> $1::vector) AS similarity`;

  // Over-fetch so reranking and the recency re-sort can promote candidates
  const fetchLimit = hybrid ? Math.max(RERANK_CANDIDATES, limit) : Math.min(limit * 3, 60);
  const params = [embeddingStr, fetchLimit];
  if (content_type !== 'all') params.push(content_type);

  const sql = `
    SELECT ${columns}
    FROM altus_content
    WHERE embedding IS NOT NULL
    ${typeFilter}
    ORDER BY embedding <=> $1::vector
    LIMIT $2
  `;

  // Keyword side: 'simple' keeps names whole (title/tags), 'english' stems
  // the body. The tsquery is built once in the CTE.
  const keywordParams = [embeddingStr, KEYWORD_CANDIDATES, ...(content_type !== 'all' ? [content_type] : []), query];
  const queryParam = `$${keywordParams.length}`;
  const keywordSql = `
    WITH q AS (
      SELECT websearch_to_tsquery('simple', ${queryParam}) || websearch_to_tsquery('english', ${queryParam}) AS tsq
    )
    SELECT ${columns}, ts_rank_cd(search_tsv, q.tsq) AS keyword_rank
    FROM altus_content, q
    WHERE embedding IS NOT NULL
      AND search_tsv @@ q.tsq
      ${typeFilter}
    ORDER BY keyword_rank DESC
    LIMIT $2
  `;

  try {
    const [searchResult, countResult, keywordResult] = await Promise.all([
      pool.query(sql, params),
      // Reuse the caller's archive count when provided — avoids a redundant
      // full-table COUNT(*) on every fan-out search.
      totalSearched != null
        ? { rows: [{ count: totalSearched }] }
        : pool.query('SELECT COUNT(*) FROM altus_content WHERE embedding IS NOT NULL'),
      hybrid
        ? Promise.resolve().then(() => pool.query(keywordSql, keywordParams)).catch((err) => {
            logger.warn('Archive keyword search failed; using vector results only', { error: err.message });
            return { rows: [] };
          })
        : { rows: [] },
    ]);

    let candidates = fuseCandidates(searchResult.rows, keywordResult?.rows ?? []);
    let ranking = 'vector_similarity';
    if (hybrid && candidates.length > 1) {
      const reranked = await rerankDocuments(
        query,
        candidates.map((row) => `${row.title}${row.tags?.length ? `\nTags: ${row.tags.join(', ')}` : ''}\n\n${row.rerank_text ?? row.snippet ?? ''}`),
      );
      if (Array.isArray(reranked)) {
        candidates = reranked.map(({ index, relevance_score }) => ({ ...candidates[index], relevance: relevance_score }));
        ranking = 'reranked';
      } else {
        logger.warn('Archive search rerank failed; using rank fusion', { error: reranked?.error });
        ranking = 'fused';
      }
    }

    const scoreOf = (row) => (ranking === 'reranked' ? row.relevance : ranking === 'fused' ? row.fused : row.similarity);

    // Apply recency weighting, re-sort, trim to requested limit
    const weighted = candidates
      .map((row) => ({
        ...row,
        weighted_score: applyRecencyWeight(
          scoreOf(row),
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
      ...(ranking === 'reranked' ? { relevance: row.relevance } : {}),
      ...(hybrid ? { match: row.match } : {}),
      weighted_score: row.weighted_score,
    }));

    logger.info('Archive search completed', {
      query, results: results.length, content_type, ranking, keyword_hits: keywordResult?.rows?.length ?? 0,
    });

    return {
      results,
      ranking,
      total_searched: parseInt(countResult.rows[0].count, 10),
      query,
    };
  } catch (err) {
    logger.error('Archive search failed', { error: err.message });
    return { error: 'Search failed — database error' };
  }
}
