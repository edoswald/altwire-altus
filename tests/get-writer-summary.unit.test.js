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
      refreshOpportunityQueue: vi.fn().mockRejectedValue(new Error('queue refresh offline')),
      listStoryOpportunityQueue: vi.fn().mockRejectedValue(new Error('queue list offline')),
      getAltwireMorningDigest: vi.fn().mockRejectedValue(new Error('digest offline')),
    });

    expect(result.success).toBe(true);
    expect(result.degraded).toBe(true);
    expect(result.warnings).toEqual([
      expect.objectContaining({ source: 'digest' }),
      expect.objectContaining({ source: 'analytics' }),
      expect.objectContaining({ source: 'opportunities_refresh' }),
      expect.objectContaining({ source: 'opportunities' }),
    ]);
    expect(result.analytics.pageviews_today).toBe(0);
  });

  it('summarizes active queued story opportunities including Google News watch-list matches', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ count: '2' }] })
      .mockResolvedValueOnce({ rows: [{ count: '1' }] })
      .mockResolvedValueOnce({ rows: [{ count: '1' }] });

    const refreshOpportunityQueue = vi.fn().mockResolvedValue({
      success: true,
      story: { upserted: 1 },
      news: { upserted: 1, matches: 1, queries: 4 },
      warnings: [],
    });
    const listStoryOpportunityQueue = vi.fn().mockResolvedValue({
      success: true,
      opportunities: [
        {
          id: 10,
          topic: 'radiohead tour news',
          priority: 'high',
          status: 'pending',
          source: 'Google News',
          coverage_status: 'watch_list_match',
        },
        {
          id: 11,
          topic: 'sleep token interview',
          priority: 'medium',
          status: 'in_progress',
          source: 'GSC opportunity zone',
          coverage_status: 'weak_coverage',
        },
      ],
    });

    const result = await buildWriterSummary({
      getTrafficSummary: vi.fn().mockResolvedValue({ pageviews: 44, top_article_title: 'Top story' }),
      refreshOpportunityQueue,
      listStoryOpportunityQueue,
      getAltwireMorningDigest: vi.fn().mockResolvedValue({ generated_at: '2026-06-16T10:00:00Z', warnings: [] }),
    });

    expect(refreshOpportunityQueue).toHaveBeenCalledWith({ days: 28, includeNews: true });
    expect(listStoryOpportunityQueue).toHaveBeenCalledWith({ status: 'active', limit: 25 });
    expect(result.opportunities).toEqual({
      high: 1,
      medium: 2,
      low: 0,
      pending: 1,
      active: 2,
      total: 2,
      by_priority: { critical: 0, high: 1, medium: 1, low: 0 },
      by_source: { google_news: 1, gsc_opportunity_zone: 1, other: 0 },
      watch_list_matches: 1,
      refreshed: { story_upserted: 1, news_upserted: 1, news_matches: 1, warnings: [] },
      top: [
        expect.objectContaining({ id: 10, topic: 'radiohead tour news', source: 'Google News' }),
        expect.objectContaining({ id: 11, topic: 'sleep token interview', source: 'GSC opportunity zone' }),
      ],
    });
  });
});
