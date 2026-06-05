import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/altus-db.js', () => ({
  default: {
    query: vi.fn(),
  },
}));

import pool from '../lib/altus-db.js';
import { buildWriterSummary } from '../handlers/altus-writer-summary.js';

describe('buildWriterSummary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DATABASE_URL = 'postgres://test';
  });

  it('marks the summary degraded and records warnings when upstream sources fail', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ count: '3' }] })
      .mockResolvedValueOnce({ rows: [{ count: '1' }] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] });

    const result = await buildWriterSummary({
      getTrafficSummary: vi.fn().mockRejectedValue(new Error('matomo offline')),
      getSearchOpportunities: vi.fn().mockRejectedValue(new Error('gsc offline')),
      getAltwireMorningDigest: vi.fn().mockRejectedValue(new Error('digest offline')),
    });

    expect(result.success).toBe(true);
    expect(result.degraded).toBe(true);
    expect(result.warnings).toEqual([
      expect.objectContaining({ source: 'digest' }),
      expect.objectContaining({ source: 'analytics' }),
      expect.objectContaining({ source: 'opportunities' }),
    ]);
    expect(result.analytics.pageviews_today).toBe(0);
  });
});
