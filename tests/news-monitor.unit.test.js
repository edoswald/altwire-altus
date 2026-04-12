import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock pool (default export from altus-db.js)
const mockQuery = vi.fn();
vi.mock('../lib/altus-db.js', () => ({
  default: { query: mockQuery },
}));

// Mock logger
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock GSC client
const mockGetNewsSearchPerformance = vi.fn();
vi.mock('../handlers/altwire-gsc-client.js', () => ({
  getNewsSearchPerformance: mockGetNewsSearchPerformance,
}));

describe('altus-news-monitor', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    mockQuery.mockReset();
    mockGetNewsSearchPerformance.mockReset();
  });

  describe('getNewsOpportunities', () => {
    // Requirement 7.6: TEST_MODE returns mock data
    it('returns mock data with test_mode flag when TEST_MODE=true', async () => {
      vi.stubEnv('TEST_MODE', 'true');
      const { getNewsOpportunities } = await import('../handlers/altus-news-monitor.js');

      const result = await getNewsOpportunities();

      expect(result.test_mode).toBe(true);
      expect(result.success).toBe(true);
      expect(result.news_queries).toBeInstanceOf(Array);
      expect(result.news_queries.length).toBeGreaterThan(0);
      expect(result.watch_list_matches).toBeInstanceOf(Array);
      expect(result.news_pages).toBeInstanceOf(Array);
      expect(mockGetNewsSearchPerformance).not.toHaveBeenCalled();
    });

    // Requirement 7.7: Missing DATABASE_URL returns error
    it('returns error when DATABASE_URL is not set', async () => {
      vi.stubEnv('DATABASE_URL', '');
      const { getNewsOpportunities } = await import('../handlers/altus-news-monitor.js');

      const result = await getNewsOpportunities();

      expect(result).toEqual({ error: 'Database not configured' });
    });

    // Requirement 7.4: Zero GSC News rows returns empty arrays with note
    it('returns empty arrays with note when GSC returns zero News rows', async () => {
      vi.stubEnv('DATABASE_URL', 'postgres://localhost/test');
      // GSC query dimension returns zero rows
      mockGetNewsSearchPerformance.mockResolvedValueOnce({ rows: [] });
      // GSC page dimension returns zero rows
      mockGetNewsSearchPerformance.mockResolvedValueOnce({ rows: [] });

      const { getNewsOpportunities } = await import('../handlers/altus-news-monitor.js');
      const result = await getNewsOpportunities();

      expect(result.news_queries).toEqual([]);
      expect(result.watch_list_matches).toEqual([]);
      expect(result.news_pages).toEqual([]);
      expect(result.note).toBeDefined();
      expect(result.note).toContain('No Google News data');
    });

    // Requirement 7.5: Missing watch list table handled gracefully
    it('returns watch_list_matches as empty array when altus_watch_list table is missing', async () => {
      vi.stubEnv('DATABASE_URL', 'postgres://localhost/test');
      // GSC returns some news queries
      mockGetNewsSearchPerformance.mockResolvedValueOnce({
        rows: [{ keys: ['rock band tour'], clicks: 5, impressions: 100, ctr: 0.05, position: 8 }],
      });
      // GSC page dimension
      mockGetNewsSearchPerformance.mockResolvedValueOnce({
        rows: [{ keys: ['https://altwire.net/tour-news/'], clicks: 3, impressions: 80, ctr: 0.04, position: 10 }],
      });
      // Watch list query throws (table doesn't exist)
      mockQuery.mockRejectedValueOnce(new Error('relation "altus_watch_list" does not exist'));

      const { getNewsOpportunities } = await import('../handlers/altus-news-monitor.js');
      const result = await getNewsOpportunities();

      expect(result.watch_list_matches).toEqual([]);
      expect(result.watch_list_note).toContain('not available');
      expect(result.news_queries.length).toBe(1);
      expect(result.news_pages.length).toBe(1);
    });
  });

  describe('runNewsMonitorCron', () => {
    // Requirement 10.4, 10.5: Cron stores alert in agent_memory
    it('stores alert in agent_memory with correct key pattern', async () => {
      vi.stubEnv('DATABASE_URL', 'postgres://localhost/test');
      // GSC query dimension
      mockGetNewsSearchPerformance.mockResolvedValueOnce({
        rows: [{ keys: ['metal festival 2025'], clicks: 12, impressions: 300, ctr: 0.04, position: 6 }],
      });
      // GSC page dimension
      mockGetNewsSearchPerformance.mockResolvedValueOnce({
        rows: [],
      });
      // Watch list query returns empty
      mockQuery.mockResolvedValueOnce({ rows: [] });
      // INSERT INTO agent_memory succeeds
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const { runNewsMonitorCron } = await import('../handlers/altus-news-monitor.js');
      await runNewsMonitorCron();

      // Find the INSERT INTO agent_memory call
      const insertCall = mockQuery.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].includes('INSERT INTO agent_memory')
      );
      expect(insertCall).toBeDefined();
      expect(insertCall[1][0]).toBe('altus');
      expect(insertCall[1][1]).toMatch(/^altus:news_alert:\d{4}-\d{2}-\d{2}$/);
      // Value should be a JSON string
      const storedValue = JSON.parse(insertCall[1][2]);
      expect(storedValue).toHaveProperty('news_queries');
    });

    // Requirement 10.6: Cron skips when DATABASE_URL not set
    it('skips execution when DATABASE_URL is not set', async () => {
      vi.stubEnv('DATABASE_URL', '');
      const { runNewsMonitorCron } = await import('../handlers/altus-news-monitor.js');

      await runNewsMonitorCron();

      expect(mockGetNewsSearchPerformance).not.toHaveBeenCalled();
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });
});
