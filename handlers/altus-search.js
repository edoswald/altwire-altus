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
 *
 * Filters (all optional): published_after / published_before (YYYY-MM-DD,
 * inclusive), categories and tags (match any, case-insensitive). With no
 * query the call browses instead of searching: matching items in date
 * order, paged with offset, plus the total count.
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

const BROWSE_MAX = 50;

/**
 * SQL conditions for the optional filters. `add` appends a parameter and
 * returns its placeholder. Exported for tests.
 */
export function buildFilterClauses(filters, add) {
  const clauses = [];
  const { content_type: contentType, published_after: after, published_before: before, categories, tags } = filters;
  if (contentType && contentType !== 'all') clauses.push(`content_type = ${add(contentType)}`);
  if (after) clauses.push(`published_at >= ${add(after)}::date`);
  if (before) clauses.push(`published_at < (${add(before)}::date + 1)`);
  const lowered = (list) => list.map((v) => String(v).trim().toLowerCase()).filter(Boolean);
  if (categories?.length) {
    clauses.push(`EXISTS (SELECT 1 FROM unnest(categories) c WHERE lower(c) = ANY(${add(lowered(categories))}))`);
  }
  if (tags?.length) {
    clauses.push(`EXISTS (SELECT 1 FROM unnest(tags) t WHERE lower(t) = ANY(${add(lowered(tags))}))`);
  }
  return clauses;
}

function paramList() {
  const params = [];
  const add = (value) => { params.push(value); return `$${params.length}`; };
  return { params, add };
}

function formatResult(row, extra = {}) {
  return {
    type: row.content_type,
    title: row.title,
    slug: row.slug ?? null,
    url: row.url,
    published_at: row.published_at ? new Date(row.published_at).toISOString() : null,
    categories: row.categories ?? [],
    tags: row.tags ?? [],
    snippet: row.snippet ?? '',
    ...extra,
  };
}

function appliedFilters(opts) {
  const out = {};
  for (const key of ['content_type', 'published_after', 'published_before', 'categories', 'tags']) {
    const v = opts[key];
    if (v != null && v !== 'all' && !(Array.isArray(v) && !v.length)) out[key] = v;
  }
  return out;
}

/** List archive items matching the filters, in date order (no query). */
async function browseArchive({ limit, offset = 0, sort = 'newest', ...filters }) {
  const { params, add } = paramList();
  const where = ['TRUE', ...buildFilterClauses(filters, add)].join(' AND ');
  const pageSize = Math.min(Math.max(Number(limit) || 20, 1), BROWSE_MAX);
  const order = sort === 'oldest' ? 'published_at ASC NULLS LAST' : 'published_at DESC NULLS LAST';
  const rowsSql = `
    SELECT content_type, title, slug, url, published_at, categories, tags, LEFT(raw_text, 300) AS snippet
    FROM altus_content WHERE ${where}
    ORDER BY ${order}, id
    LIMIT ${add(pageSize)} OFFSET ${add(Math.max(Number(offset) || 0, 0))}`;
  const countParams = params.slice(0, params.length - 2);
  const [rowsResult, countResult] = await Promise.all([
    pool.query(rowsSql, params),
    pool.query(`SELECT COUNT(*) FROM altus_content WHERE ${where}`, countParams),
  ]);
  const total = parseInt(countResult.rows[0].count, 10);
  const results = rowsResult.rows.map((row) => formatResult(row));
  const nextOffset = (Number(offset) || 0) + results.length;
  return {
    mode: 'browse',
    results,
    total_matching: total,
    offset: Number(offset) || 0,
    ...(nextOffset < total ? { next_offset: nextOffset } : {}),
    filters: appliedFilters(filters),
  };
}

/**
 * @param {object} params
 * @param {string} [params.query]        omit to browse by filters in date order
 * @param {number} params.limit
 * @param {'post'|'gallery'|'all'} [params.content_type]
 * @param {string} [params.published_after]   YYYY-MM-DD
 * @param {string} [params.published_before]  YYYY-MM-DD
 * @param {string[]} [params.categories]
 * @param {string[]} [params.tags]
 * @param {'relevance'|'newest'|'oldest'} [params.sort]
 * @param {number} [params.offset]       browse mode paging
 * @param {number[]} [params.embedding]  precomputed query vector (fan-out callers)
 * @param {number} [params.totalSearched]
 * @param {boolean} [params.rerank]
 * @returns {Promise<object>} results or { error: string }
 */
export async function searchAltwireArchive(opts) {
  const { query, limit, embedding: precomputedEmbedding, totalSearched, rerank, sort = 'relevance', offset } = opts;
  const filters = {
    content_type: opts.content_type,
    published_after: opts.published_after,
    published_before: opts.published_before,
    categories: opts.categories,
    tags: opts.tags,
  };
  if (!hasDbConfig()) {
    return { error: 'Database not configured' };
  }

  if (!query?.trim() && !Array.isArray(precomputedEmbedding)) {
    try {
      return await browseArchive({ limit, offset, sort: sort === 'oldest' ? 'oldest' : 'newest', ...filters });
    } catch (err) {
      logger.error('Archive browse failed', { error: err.message });
      return { error: 'Search failed — database error' };
    }
  }

  // Fan-out callers pass a precomputed vector and get plain vector search.
  const hybrid = rerank ?? !Array.isArray(precomputedEmbedding);

  // Embed here only when the caller did not supply a precomputed vector.
  let vector = precomputedEmbedding;
  if (!Array.isArray(vector)) {
    vector = await embedQuery(query);
    if (vector?.error) {
      return { error: vector.error };
    }
  }

  const embeddingStr = `[${vector.join(',')}]`;
  const columns = (embParam) => `
      id, content_type, title, slug, url, published_at, categories, tags,
      LEFT(raw_text, 300) AS snippet,
      ${hybrid ? `LEFT(raw_text, ${RERANK_TEXT_CHARS}) AS rerank_text,` : ''}
      1 - (embedding <=> ${embParam}::vector) AS similarity`;

  // Over-fetch so reranking and the recency re-sort can promote candidates
  const fetchLimit = hybrid ? Math.max(RERANK_CANDIDATES, limit) : Math.min(limit * 3, 60);

  const vec = paramList();
  const vecEmb = vec.add(embeddingStr);
  const vecFilters = buildFilterClauses(filters, vec.add);
  const sql = `
    SELECT ${columns(vecEmb)}
    FROM altus_content
    WHERE embedding IS NOT NULL
    ${vecFilters.map((c) => `AND ${c}`).join('\n    ')}
    ORDER BY embedding <=> ${vecEmb}::vector
    LIMIT ${vec.add(fetchLimit)}
  `;

  // Keyword side: 'simple' keeps names whole (title/tags), 'english' stems
  // the body. The tsquery is built once in the CTE.
  const kw = paramList();
  const kwEmb = kw.add(embeddingStr);
  const kwQuery = kw.add(query);
  const kwFilters = buildFilterClauses(filters, kw.add);
  const keywordSql = `
    WITH q AS (
      SELECT websearch_to_tsquery('simple', ${kwQuery}) || websearch_to_tsquery('english', ${kwQuery}) AS tsq
    )
    SELECT ${columns(kwEmb)}, ts_rank_cd(search_tsv, q.tsq) AS keyword_rank
    FROM altus_content, q
    WHERE embedding IS NOT NULL
      AND search_tsv @@ q.tsq
      ${kwFilters.map((c) => `AND ${c}`).join('\n      ')}
    ORDER BY keyword_rank DESC
    LIMIT ${kw.add(KEYWORD_CANDIDATES)}
  `;

  try {
    const [searchResult, countResult, keywordResult] = await Promise.all([
      pool.query(sql, vec.params),
      // Reuse the caller's archive count when provided — avoids a redundant
      // full-table COUNT(*) on every fan-out search.
      totalSearched != null
        ? { rows: [{ count: totalSearched }] }
        : pool.query('SELECT COUNT(*) FROM altus_content WHERE embedding IS NOT NULL'),
      hybrid
        ? Promise.resolve().then(() => pool.query(keywordSql, kw.params)).catch((err) => {
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
    // An explicit date range means the caller wants that period, so recent
    // pieces get no boost.
    const dated = Boolean(filters.published_after || filters.published_before);

    // Apply recency weighting, re-sort, trim to requested limit
    let weighted = candidates
      .map((row) => ({
        ...row,
        weighted_score: dated
          ? parseFloat(Number(scoreOf(row) ?? 0).toFixed(6))
          : applyRecencyWeight(scoreOf(row), row.published_at ? new Date(row.published_at).toISOString() : null),
      }))
      .sort((a, b) => b.weighted_score - a.weighted_score)
      .slice(0, limit);
    if (sort === 'newest' || sort === 'oldest') {
      const dir = sort === 'newest' ? -1 : 1;
      weighted = weighted.sort((a, b) => dir * (new Date(a.published_at ?? 0) - new Date(b.published_at ?? 0)));
    }

    const results = weighted.map((row) => formatResult(row, {
      similarity: row.similarity,
      ...(ranking === 'reranked' ? { relevance: row.relevance } : {}),
      ...(hybrid ? { match: row.match } : {}),
      weighted_score: row.weighted_score,
    }));

    logger.info('Archive search completed', {
      query, results: results.length, ranking, keyword_hits: keywordResult?.rows?.length ?? 0, filters: appliedFilters(filters),
    });

    const applied = appliedFilters(filters);
    return {
      results,
      ranking,
      ...(Object.keys(applied).length ? { filters: applied } : {}),
      total_searched: parseInt(countResult.rows[0].count, 10),
      query,
    };
  } catch (err) {
    logger.error('Archive search failed', { error: err.message });
    return { error: 'Search failed — database error' };
  }
}
