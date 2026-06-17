import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetStoryOpportunities = vi.fn();
const mockGetNewsOpportunities = vi.fn();
const mockUpsertStoryOpportunityQueue = vi.fn();
const mockUpsertNewsOpportunityQueue = vi.fn();
const mockPoolQuery = vi.fn();

vi.mock('../lib/altus-db.js', () => ({
  default: { query: mockPoolQuery },
}));

vi.mock('../handlers/altus-topic-discovery.js', () => ({
  getStoryOpportunities: mockGetStoryOpportunities,
}));

vi.mock('../handlers/altus-news-monitor.js', () => ({
  getNewsOpportunities: mockGetNewsOpportunities,
}));

vi.mock('../handlers/altus-opportunity-queue.js', () => ({
  upsertStoryOpportunityQueue: mockUpsertStoryOpportunityQueue,
  upsertNewsOpportunityQueue: mockUpsertNewsOpportunityQueue,
}));

describe('altus-opportunity-refresh', () => {
  beforeEach(() => {
    vi.resetModules();
    mockGetStoryOpportunities.mockReset();
    mockGetNewsOpportunities.mockReset();
    mockUpsertStoryOpportunityQueue.mockReset();
    mockUpsertNewsOpportunityQueue.mockReset();
    mockPoolQuery.mockReset();
    mockPoolQuery.mockResolvedValue({ rows: [] });
  });

  it('refreshes both story opportunities and Google News matches into the queue', async () => {
    const storyResult = {
      opportunities: [{ query: 'sleep token interview', impressions: 900, position: 9 }],
    };
    const newsResult = {
      news_queries: [{ keys: ['radiohead tour news'], impressions: 300, clicks: 12 }],
      watch_list_matches: [{ query: 'radiohead tour news', matched_items: ['Radiohead'] }],
      news_pages: [{ keys: ['https://altwire.net/radiohead/'] }],
    };
    mockGetStoryOpportunities.mockResolvedValue(storyResult);
    mockGetNewsOpportunities.mockResolvedValue(newsResult);
    mockUpsertStoryOpportunityQueue.mockResolvedValue({ success: true, upserted: 1 });
    mockUpsertNewsOpportunityQueue.mockResolvedValue({ success: true, upserted: 1 });

    const { refreshOpportunityQueue } = await import('../handlers/altus-opportunity-refresh.js');
    const result = await refreshOpportunityQueue({ days: 28, includeNews: true });

    expect(mockGetStoryOpportunities).toHaveBeenCalledWith({ days: 28, refresh: true });
    expect(mockUpsertStoryOpportunityQueue).toHaveBeenCalledWith(storyResult);
    expect(mockGetNewsOpportunities).toHaveBeenCalledWith({ days: 7 });
    expect(mockUpsertNewsOpportunityQueue).toHaveBeenCalledWith(newsResult);
    // Snapshot is persisted under today's news_alert key so a manual Sync heals the digest count.
    expect(mockPoolQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO agent_memory'),
      expect.arrayContaining(['altus', expect.stringMatching(/^altus:news_alert:\d{4}-\d{2}-\d{2}$/), JSON.stringify(newsResult)]),
    );
    expect(result).toEqual({
      success: true,
      story: { upserted: 1 },
      news: { upserted: 1, matches: 1, queries: 1 },
      warnings: [],
    });
  });
});
