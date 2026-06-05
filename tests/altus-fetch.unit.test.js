import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/altus-db.js', () => ({
  default: {
    query: vi.fn(),
  },
}));

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
  },
}));

import pool from '../lib/altus-db.js';
import { getContentByUrl } from '../handlers/altus-fetch.js';

describe('getContentByUrl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DATABASE_URL = 'postgres://test';
  });

  it('refuses ambiguous fuzzy slug fallback matches instead of returning an arbitrary row', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          { title: 'Match A', slug: 'news/foo-bar', url: 'https://altwire.net/news/foo-bar' },
          { title: 'Match B', slug: 'features/foo-bar', url: 'https://altwire.net/features/foo-bar' },
        ],
      });

    const result = await getContentByUrl({ url: 'https://altwire.net/foo-bar/' });

    expect(result.found).toBe(false);
    expect(result.error).toBe('ambiguous_slug_match');
    expect(result.matches).toHaveLength(2);
  });
});
