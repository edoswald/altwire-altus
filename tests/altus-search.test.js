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
    expect(result.ranking).toBe('reranked');
    expect(result.results.map((r) => r.title)).toEqual(['Exactly about it', 'Loosely related']);
    expect(result.results[0].relevance).toBe(0.95);
    delete process.env.DATABASE_URL;
  });

  it('falls back to vector similarity when reranking fails', async () => {
    mockSearch({ rerank: async () => ({ error: 'HTTP 500' }) });
    const { searchAltwireArchive } = await import('../handlers/altus-search.js');
    const result = await searchAltwireArchive({ query: 'the thing', limit: 5, content_type: 'all' });
    expect(result.ranking).toBe('vector_similarity');
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
});
