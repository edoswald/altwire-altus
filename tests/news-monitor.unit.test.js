import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock pool (default export from altus-db.js)
const mockQuery = vi.fn();
vi.mock('../lib/altus-db.js', () => ({
  default: { query: mockQuery },
  hasDbConfig: () => Boolean(process.env.ALTWIRE_DATABASE_URL || process.env.DATABASE_URL),
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

vi.mock('../altus-event-log.js', () => ({
  logAltusEvent: vi.fn(),
}));

const mockUpsertNewsOpportunityQueue = vi.fn();
vi.mock('../handlers/altus-opportunity-queue.js', () => ({
  upsertNewsOpportunityQueue: mockUpsertNewsOpportunityQueue,
}));

describe('altus-news-monitor', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    mockQuery.mockReset();
    mockGetNewsSearchPerformance.mockReset();
    mockUpsertNewsOpportunityQueue.mockReset();
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

    // Requirement 7.7: Missing database URL returns error
    it('returns error when no Altus database env is set', async () => {
      vi.stubEnv('DATABASE_URL', '');
      vi.stubEnv('ALTWIRE_DATABASE_URL', '');
      const { getNewsOpportunities } = await import('../handlers/altus-news-monitor.js');

      const result = await getNewsOpportunities();

      expect(result).toEqual({ error: 'Database not configured' });
    });

    // Requirement 7.4: Zero GSC News rows returns empty arrays with note
    it('returns empty arrays with note when GSC returns zero News rows', async () => {
      vi.stubEnv('ALTWIRE_DATABASE_URL', 'postgres://localhost/test');
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
      vi.stubEnv('ALTWIRE_DATABASE_URL', 'postgres://localhost/test');
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

    it('only matches active watch list subjects', async () => {
      vi.stubEnv('ALTWIRE_DATABASE_URL', 'postgres://localhost/test');
      mockGetNewsSearchPerformance.mockResolvedValueOnce({
        rows: [{ keys: ['radiohead tour news'], clicks: 5, impressions: 100, ctr: 0.05, position: 8 }],
      });
      mockGetNewsSearchPerformance.mockResolvedValueOnce({ rows: [] });
      mockQuery.mockResolvedValueOnce({ rows: [{ name: 'Radiohead' }] });

      const { getNewsOpportunities } = await import('../handlers/altus-news-monitor.js');
      await getNewsOpportunities();

      expect(mockQuery).toHaveBeenCalledWith('SELECT name FROM altus_watch_list WHERE active = true');
    });

    it('filters non-English Google News queries out of returned recommendations', async () => {
      vi.stubEnv('ALTWIRE_DATABASE_URL', 'postgres://localhost/test');
      mockGetNewsSearchPerformance.mockResolvedValueOnce({
        rows: [
          { keys: ['radiohead tour news'], clicks: 5, impressions: 100, ctr: 0.05, position: 8 },
          { keys: ['noticias de radiohead en espanol'], clicks: 8, impressions: 180, ctr: 0.04, position: 6 },
        ],
      });
      mockGetNewsSearchPerformance.mockResolvedValueOnce({ rows: [] });
      mockQuery.mockResolvedValueOnce({ rows: [{ name: 'Radiohead' }] });

      const { getNewsOpportunities } = await import('../handlers/altus-news-monitor.js');
      const result = await getNewsOpportunities();

      expect(result.news_queries).toEqual([
        expect.objectContaining({ keys: ['radiohead tour news'] }),
      ]);
      expect(result.watch_list_matches).toEqual([
        expect.objectContaining({
          query: 'radiohead tour news',
          matched_items: ['Radiohead'],
        }),
      ]);
    });
  });

  describe('runNewsMonitorCron', () => {
    // Requirement 10.4, 10.5: Cron stores alert in agent_memory
    it('stores alert in agent_memory with correct key pattern', async () => {
      vi.stubEnv('ALTWIRE_DATABASE_URL', 'postgres://localhost/test');
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

    it('persists Google News watch-list matches into the opportunity queue', async () => {
      vi.stubEnv('ALTWIRE_DATABASE_URL', 'postgres://localhost/test');
      mockGetNewsSearchPerformance.mockResolvedValueOnce({
        rows: [{ keys: ['radiohead tour news'], clicks: 12, impressions: 300, ctr: 0.04, position: 6 }],
      });
      mockGetNewsSearchPerformance.mockResolvedValueOnce({
        rows: [{ keys: ['https://altwire.net/radiohead/'], clicks: 3, impressions: 80, ctr: 0.04, position: 10 }],
      });
      mockQuery.mockResolvedValueOnce({ rows: [{ name: 'Radiohead' }] });
      mockQuery.mockResolvedValueOnce({ rows: [] });
      mockUpsertNewsOpportunityQueue.mockResolvedValueOnce({ success: true, upserted: 1 });

      const { runNewsMonitorCron } = await import('../handlers/altus-news-monitor.js');
      await runNewsMonitorCron();

      expect(mockUpsertNewsOpportunityQueue).toHaveBeenCalledWith(expect.objectContaining({
        watch_list_matches: [
          expect.objectContaining({
            query: 'radiohead tour news',
            matched_items: ['Radiohead'],
          }),
        ],
      }));
    });

    it('accepts ALTWIRE_DATABASE_URL as sufficient database config', async () => {
      vi.stubEnv('DATABASE_URL', '');
      vi.stubEnv('ALTWIRE_DATABASE_URL', 'postgres://localhost/test');
      mockGetNewsSearchPerformance.mockResolvedValueOnce({ rows: [] });
      mockGetNewsSearchPerformance.mockResolvedValueOnce({ rows: [] });

      const { runNewsMonitorCron } = await import('../handlers/altus-news-monitor.js');
      await runNewsMonitorCron();

      expect(mockGetNewsSearchPerformance).toHaveBeenCalled();
    });

    // Requirement 10.6: Cron skips when no database URL is set
    it('skips execution when no database env is set', async () => {
      vi.stubEnv('DATABASE_URL', '');
      vi.stubEnv('ALTWIRE_DATABASE_URL', '');
      const { runNewsMonitorCron } = await import('../handlers/altus-news-monitor.js');

      await runNewsMonitorCron();

      expect(mockGetNewsSearchPerformance).not.toHaveBeenCalled();
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });
});
