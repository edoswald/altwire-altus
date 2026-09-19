import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/altus-db.js', () => ({
  readAgentMemory: vi.fn(),
  writeAgentMemory: vi.fn(),
  pool: {
    query: vi.fn(),
  },
}));

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { pool } from '../lib/altus-db.js';
import { getContentIdeas, listTrackedArticles, trackArticle } from '../handlers/altus-editorial-tools.js';
import { writeAgentMemory } from '../lib/altus-db.js';

describe('altus editorial tools list metadata', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports actual tracked-article totals even when the result set is limited', async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [{ key: 'altwire:article:one', value: JSON.stringify({ title: 'One' }) }],
      })
      .mockResolvedValueOnce({
        rows: [{ count: '5' }],
      });

    const result = await listTrackedArticles({ limit: 1 });

    expect(result.articles).toHaveLength(1);
    expect(result.total).toBe(5);
  });

  it('reports actual idea totals even when the result set is limited', async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [{ key: 'altwire:idea:one', value: JSON.stringify({ topic: 'One' }) }],
      })
      .mockResolvedValueOnce({
        rows: [{ count: '7' }],
      });

    const result = await getContentIdeas({ limit: 1 });

    expect(result.ideas).toHaveLength(1);
    expect(result.total).toBe(7);
  });

  it('stores new editorial tracking state under the Altus agent', async () => {
    writeAgentMemory.mockResolvedValueOnce({ success: true });

    await trackArticle({
      url: 'https://altwire.net/reviews/test-camera',
      title: 'Test Camera',
      category: 'reviews',
    });

    expect(writeAgentMemory).toHaveBeenCalledWith(
      'altus',
      'altwire:article:reviews/test-camera',
      expect.stringContaining('Test Camera'),
    );
  });
});
