import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('voyage.js', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('embedDocuments returns structured error when VOYAGE_API_KEY is missing', async () => {
    const saved = process.env.VOYAGE_API_KEY;
    delete process.env.VOYAGE_API_KEY;
    const { embedDocuments } = await import('../lib/voyage.js');
    const result = await embedDocuments(['hello world']);
    expect(result).toEqual({ error: 'Embedding service unavailable — VOYAGE_API_KEY not set' });
    if (saved !== undefined) process.env.VOYAGE_API_KEY = saved;
  });

  it('embedQuery returns structured error when VOYAGE_API_KEY is missing', async () => {
    const saved = process.env.VOYAGE_API_KEY;
    delete process.env.VOYAGE_API_KEY;
    const { embedQuery } = await import('../lib/voyage.js');
    const result = await embedQuery('test query');
    expect(result).toEqual({ error: 'Embedding service unavailable — VOYAGE_API_KEY not set' });
    if (saved !== undefined) process.env.VOYAGE_API_KEY = saved;
  });

  it('embedDocuments calls Voyage API with document input_type and batches correctly', async () => {
    process.env.VOYAGE_API_KEY = 'test-key';
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { embedding: Array(1024).fill(0.1) },
          { embedding: Array(1024).fill(0.2) },
        ],
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const { embedDocuments } = await import('../lib/voyage.js');
    const result = await embedDocuments(['text one', 'text two']);

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
    expect(result[0]).toHaveLength(1024);

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.input_type).toBe('document');
    expect(callBody.model).toBe('voyage-3-lite');

    vi.unstubAllGlobals();
    delete process.env.VOYAGE_API_KEY;
  });

  it('embedQuery calls Voyage API with query input_type', async () => {
    process.env.VOYAGE_API_KEY = 'test-key';
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ embedding: Array(1024).fill(0.5) }],
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const { embedQuery } = await import('../lib/voyage.js');
    const result = await embedQuery('artist name');

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1024);

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.input_type).toBe('query');

    vi.unstubAllGlobals();
    delete process.env.VOYAGE_API_KEY;
  });

  it('embedDocuments returns structured error on Voyage API 429 after retries', async () => {
    process.env.VOYAGE_API_KEY = 'test-key';
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ message: 'rate limited' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const { embedDocuments } = await import('../lib/voyage.js');
    const result = await embedDocuments(['text'], { maxRetries: 1, retryDelayMs: 0 });

    expect(result).toHaveProperty('error');
    expect(result.error).toMatch(/rate limit/i);

    vi.unstubAllGlobals();
    delete process.env.VOYAGE_API_KEY;
  });
});
