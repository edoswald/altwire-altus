import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('altus-search.js', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it('returns structured error when DATABASE_URL is not set', async () => {
    const saved = process.env.DATABASE_URL;
    const savedAltwire = process.env.ALTWIRE_DATABASE_URL;
    delete process.env.DATABASE_URL;
    delete process.env.ALTWIRE_DATABASE_URL;
    const { searchAltwireArchive } = await import('../handlers/altus-search.js');
    const result = await searchAltwireArchive({ query: 'test', limit: 5, content_type: 'all' });
    expect(result.error).toBe('Database not configured');
    if (saved !== undefined) process.env.DATABASE_URL = saved;
    if (savedAltwire !== undefined) process.env.ALTWIRE_DATABASE_URL = savedAltwire;
  });

  it('returns structured error when Voyage embedding fails', async () => {
    process.env.DATABASE_URL = 'postgres://test';
    vi.doMock('../lib/voyage.js', () => ({
      embedQuery: async () => ({ error: 'Embedding service unavailable' }),
    }));
    const { searchAltwireArchive } = await import('../handlers/altus-search.js');
    const result = await searchAltwireArchive({ query: 'test', limit: 5, content_type: 'all' });
    expect(result.error).toBe('Embedding service unavailable');
    delete process.env.DATABASE_URL;
  });

  it('filters by content_type when not "all"', async () => {
    process.env.DATABASE_URL = 'postgres://test';
    const mockEmbedding = Array(1024).fill(0.1);
    vi.doMock('../lib/voyage.js', () => ({
      embedQuery: async () => mockEmbedding,
    }));
    const mockQuery = vi.fn().mockResolvedValue({
      rows: [
        {
          content_type: 'post', title: 'Test Post', url: 'https://altwire.net/post',
          published_at: new Date(), categories: ['Rock'], tags: ['live'],
          snippet: 'A great show...', similarity: 0.92,
        },
      ],
    });
    vi.doMock('../lib/altus-db.js', () => ({
      default: { query: mockQuery },
      hasDbConfig: () => Boolean(process.env.ALTWIRE_DATABASE_URL || process.env.DATABASE_URL),
    }));
    const { searchAltwireArchive } = await import('../handlers/altus-search.js');
    await searchAltwireArchive({ query: 'live show', limit: 5, content_type: 'post' });
    const sql = mockQuery.mock.calls[0][0];
    expect(sql).toContain("AND content_type = $3");
  });

  it('does not add type filter when content_type is "all"', async () => {
    process.env.DATABASE_URL = 'postgres://test';
    const mockEmbedding = Array(1024).fill(0.1);
    vi.doMock('../lib/voyage.js', () => ({
      embedQuery: async () => mockEmbedding,
    }));
    const mockQuery = vi.fn().mockResolvedValue({ rows: [] });
    vi.doMock('../lib/altus-db.js', () => ({
      default: { query: mockQuery },
      hasDbConfig: () => Boolean(process.env.ALTWIRE_DATABASE_URL || process.env.DATABASE_URL),
    }));
    const { searchAltwireArchive } = await import('../handlers/altus-search.js');
    await searchAltwireArchive({ query: 'artist', limit: 5, content_type: 'all' });
    const sql = mockQuery.mock.calls[0][0];
    expect(sql).not.toContain("AND content_type");
  });

  it('returns results array with similarity, title, url, snippet fields', async () => {
    process.env.DATABASE_URL = 'postgres://test';
    const mockEmbedding = Array(1024).fill(0.2);
    vi.doMock('../lib/voyage.js', () => ({
      embedQuery: async () => mockEmbedding,
    }));
    vi.doMock('../lib/altus-db.js', () => ({
      hasDbConfig: () => Boolean(process.env.ALTWIRE_DATABASE_URL || process.env.DATABASE_URL),
      default: {
        query: vi.fn()
          .mockResolvedValueOnce({
            rows: [
              {
                content_type: 'gallery', title: 'Glastonbury 2024', url: 'https://altwire.net/g/1',
                published_at: null, categories: [], tags: ['festival'],
                snippet: 'Big stage photos...', similarity: 0.88,
              },
            ],
          })
          .mockResolvedValueOnce({ rows: [{ count: '1563' }] }),
      },
    }));
    const { searchAltwireArchive } = await import('../handlers/altus-search.js');
    const result = await searchAltwireArchive({ query: 'glastonbury', limit: 5, content_type: 'all' });
    expect(result.results).toHaveLength(1);
    expect(result.results[0].similarity).toBeCloseTo(0.88);
    expect(result.results[0].title).toBe('Glastonbury 2024');
    expect(result.total_searched).toBe(1563);
    expect(result.query).toBe('glastonbury');
    delete process.env.DATABASE_URL;
  });

  function mockSearch({ rerank }) {
    process.env.DATABASE_URL = 'postgres://test';
    vi.doMock('../lib/voyage.js', () => ({
      embedQuery: async () => Array(512).fill(0.1),
      rerank,
    }));
    const now = new Date().toISOString();
    const mockQuery = vi.fn()
      .mockResolvedValueOnce({
        rows: [
          { content_type: 'post', title: 'Loosely related', url: 'https://altwire.net/a', published_at: now, similarity: 0.9, snippet: 'a', rerank_text: 'a long' },
          { content_type: 'post', title: 'Exactly about it', url: 'https://altwire.net/b', published_at: now, similarity: 0.8, snippet: 'b', rerank_text: 'b long' },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ count: '2' }] });
    vi.doMock('../lib/altus-db.js', () => ({
      default: { query: mockQuery },
      hasDbConfig: () => true,
    }));
    return mockQuery;
  }

  it('reranks vector candidates and orders by reranker relevance', async () => {
    const rerank = vi.fn(async () => [{ index: 1, relevance_score: 0.95 }, { index: 0, relevance_score: 0.2 }]);
    const mockQuery = mockSearch({ rerank });
    const { searchAltwireArchive } = await import('../handlers/altus-search.js');
    const result = await searchAltwireArchive({ query: 'the thing', limit: 5, content_type: 'all' });
    expect(mockQuery.mock.calls[0][0]).toContain('AS rerank_text');
    expect(mockQuery.mock.calls[0][1][1]).toBe(40);
    expect(rerank).toHaveBeenCalledWith('the thing', ['Loosely related\n\na long', 'Exactly about it\n\nb long']);
    // (rows without tags send title + text only)
    expect(result.ranking).toBe('reranked');
    expect(result.results.map((r) => r.title)).toEqual(['Exactly about it', 'Loosely related']);
    expect(result.results[0].relevance).toBe(0.95);
    delete process.env.DATABASE_URL;
  });

  it('falls back to rank fusion when reranking fails', async () => {
    mockSearch({ rerank: async () => ({ error: 'HTTP 500' }) });
    const { searchAltwireArchive } = await import('../handlers/altus-search.js');
    const result = await searchAltwireArchive({ query: 'the thing', limit: 5, content_type: 'all' });
    expect(result.ranking).toBe('fused');
    expect(result.results[0].title).toBe('Loosely related');
    delete process.env.DATABASE_URL;
  });

  it('skips reranking for fan-out callers that pass a precomputed embedding', async () => {
    const rerank = vi.fn();
    const mockQuery = mockSearch({ rerank });
    const { searchAltwireArchive } = await import('../handlers/altus-search.js');
    await searchAltwireArchive({ query: 'x', limit: 5, content_type: 'all', embedding: Array(512).fill(0), totalSearched: 2 });
    expect(rerank).not.toHaveBeenCalled();
    expect(mockQuery.mock.calls[0][0]).not.toContain('rerank_text');
    delete process.env.DATABASE_URL;
  });

  it('adds keyword matches to the candidates and tags how each result matched', async () => {
    process.env.DATABASE_URL = 'postgres://test';
    vi.doMock('../lib/voyage.js', () => ({
      embedQuery: async () => Array(512).fill(0.1),
      rerank: async (q, docs) => docs.map((_, index) => ({ index, relevance_score: 1 - index * 0.1 })),
    }));
    const now = new Date().toISOString();
    const vectorRow = { id: 1, content_type: 'post', title: 'Semantic hit', url: 'u1', published_at: now, similarity: 0.7 };
    const bothRow = { id: 2, content_type: 'post', title: 'Both', url: 'u2', published_at: now, similarity: 0.6 };
    const keywordRow = { id: 3, content_type: 'post', title: 'Deftones review', url: 'u3', published_at: now, similarity: 0.2 };
    const mockQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [vectorRow, bothRow] })
      .mockResolvedValueOnce({ rows: [{ count: '3' }] })
      .mockResolvedValueOnce({ rows: [{ ...keywordRow, keyword_rank: 2 }, { ...bothRow, keyword_rank: 1 }] });
    vi.doMock('../lib/altus-db.js', () => ({ default: { query: mockQuery }, hasDbConfig: () => true }));
    const { searchAltwireArchive } = await import('../handlers/altus-search.js');
    const result = await searchAltwireArchive({ query: 'deftones', limit: 5, content_type: 'post' });

    const [keywordSql, keywordParams] = mockQuery.mock.calls[2];
    expect(keywordSql).toContain("websearch_to_tsquery('simple', $4)");
    expect(keywordSql).toContain('AND content_type = $3');
    expect(keywordParams.slice(1)).toEqual([20, 'post', 'deftones']);
    expect(Object.fromEntries(result.results.map((r) => [r.title, r.match]))).toEqual({
      'Semantic hit': 'semantic', Both: 'both', 'Deftones review': 'keyword',
    });
    delete process.env.DATABASE_URL;
  });
});

describe('fuseCandidates', () => {
  it('scores rows found by both searches highest and normalizes to 0-1', async () => {
    const { fuseCandidates } = await import('../handlers/altus-search.js');
    const fused = fuseCandidates(
      [{ id: 1, similarity: '0.9' }, { id: 2, similarity: '0.8' }],
      [{ id: 2, keyword_rank: 3 }, { id: 3, keyword_rank: 1 }],
    );
    const byId = Object.fromEntries(fused.map((r) => [r.id, r]));
    expect(byId[2].match).toBe('both');
    expect(byId[2].fused).toBeGreaterThan(byId[1].fused);
    expect(byId[1].fused).toBeGreaterThan(byId[3].fused);
    expect(byId[2].fused).toBeLessThanOrEqual(1);
    expect(byId[1].similarity).toBe(0.9);
  });
});
