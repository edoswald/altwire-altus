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
const mockGetPagePerformance = vi.fn();
const mockGetNewsSearchPerformance = vi.fn();
vi.mock('../handlers/altwire-gsc-client.js', () => ({
  getPagePerformance: mockGetPagePerformance,
  getNewsSearchPerformance: mockGetNewsSearchPerformance,
  normalizeUrl: (url) => (typeof url === 'string' ? url.replace(/\/+$/, '') : url),
}));

describe('altus-performance-tracker', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    mockQuery.mockReset();
    mockGetPagePerformance.mockReset();
    mockGetNewsSearchPerformance.mockReset();
  });

  describe('getArticlePerformance', () => {
    // Requirement 8.6: TEST_MODE returns mock data
    it('returns mock data with test_mode flag when TEST_MODE=true', async () => {
      vi.stubEnv('TEST_MODE', 'true');
      const { getArticlePerformance } = await import('../handlers/altus-performance-tracker.js');

      const result = await getArticlePerformance();

      expect(result.test_mode).toBe(true);
      expect(result.success).toBe(true);
      expect(result.snapshots).toBeInstanceOf(Array);
      expect(result.snapshots.length).toBeGreaterThan(0);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    // Requirement 8.7: Missing DATABASE_URL returns error
    it('returns error when DATABASE_URL is not set', async () => {
      vi.stubEnv('DATABASE_URL', '');
      const { getArticlePerformance } = await import('../handlers/altus-performance-tracker.js');

      const result = await getArticlePerformance();

      expect(result).toEqual({ error: 'Database not configured' });
    });

    // Requirement 8.1: With article_url returns matching snapshots
    it('returns matching snapshots when article_url is provided', async () => {
      vi.stubEnv('DATABASE_URL', 'postgres://localhost/test');
      const snapshotRows = [
        { article_url: 'https://altwire.net/review', snapshot_type: '72h', clicks: 30, impressions: 400 },
        { article_url: 'https://altwire.net/review', snapshot_type: '7d', clicks: 120, impressions: 1500 },
      ];
      mockQuery.mockResolvedValueOnce({ rows: snapshotRows });

      const { getArticlePerformance } = await import('../handlers/altus-performance-tracker.js');
      const result = await getArticlePerformance({ article_url: 'https://altwire.net/review/' });

      expect(result.article_url).toBe('https://altwire.net/review');
      expect(result.snapshots).toEqual(snapshotRows);
      // Verify query used normalized URL (trailing slash stripped)
      expect(mockQuery.mock.calls[0][1][0]).toBe('https://altwire.net/review');
    });

    // Requirement 8.2: Without article_url returns aggregate (LIMIT 20)
    it('returns aggregate for most recent 20 articles when no article_url given', async () => {
      vi.stubEnv('DATABASE_URL', 'postgres://localhost/test');
      const aggregateRows = [
        { article_url: 'https://altwire.net/a1', snapshot_type: '72h', clicks: 10, impressions: 200 },
        { article_url: 'https://altwire.net/a2', snapshot_type: '7d', clicks: 50, impressions: 800 },
      ];
      mockQuery.mockResolvedValueOnce({ rows: aggregateRows });

      const { getArticlePerformance } = await import('../handlers/altus-performance-tracker.js');
      const result = await getArticlePerformance();

      expect(result.snapshots).toEqual(aggregateRows);
      // Verify LIMIT 20 is in the query
      const sql = mockQuery.mock.calls[0][0];
      expect(sql).toContain('LIMIT 20');
    });

    // Requirement 8.5: Zero snapshots returns empty array with note
    it('returns empty snapshots array with note when no data exists for article', async () => {
      vi.stubEnv('DATABASE_URL', 'postgres://localhost/test');
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const { getArticlePerformance } = await import('../handlers/altus-performance-tracker.js');
      const result = await getArticlePerformance({ article_url: 'https://altwire.net/no-data/' });

      expect(result.snapshots).toEqual([]);
      expect(result.note).toContain('No performance data yet');
      expect(result.note).toContain('72h');
      expect(result.note).toContain('7d');
      expect(result.note).toContain('30d');
    });
  });

  describe('getNewsPerformancePatterns', () => {
    // Requirement 9.5: TEST_MODE returns mock data
    it('returns mock data with test_mode flag when TEST_MODE=true', async () => {
      vi.stubEnv('TEST_MODE', 'true');
      const { getNewsPerformancePatterns } = await import('../handlers/altus-performance-tracker.js');

      const result = await getNewsPerformancePatterns();

      expect(result.test_mode).toBe(true);
      expect(result.success).toBe(true);
      expect(result.patterns).toBeInstanceOf(Array);
      expect(result.patterns.length).toBeGreaterThan(0);
      expect(mockGetNewsSearchPerformance).not.toHaveBeenCalled();
    });

    // Requirement 9.6: Missing DATABASE_URL returns error
    it('returns error when DATABASE_URL is not set', async () => {
      vi.stubEnv('DATABASE_URL', '');
      const { getNewsPerformancePatterns } = await import('../handlers/altus-performance-tracker.js');

      const result = await getNewsPerformancePatterns();

      expect(result).toEqual({ error: 'Database not configured' });
    });
  });

  describe('registerArticleForTracking', () => {
    // Requirement 12.3: TEST_MODE returns mock data
    it('returns mock data with test_mode flag when TEST_MODE=true', async () => {
      vi.stubEnv('TEST_MODE', 'true');
      const { registerArticleForTracking } = await import('../handlers/altus-performance-tracker.js');

      const result = await registerArticleForTracking({
        articleUrl: 'https://altwire.net/new-article/',
      });

      expect(result.test_mode).toBe(true);
      expect(result.success).toBe(true);
      expect(result.article_url).toBe('https://altwire.net/new-article');
      expect(mockQuery).not.toHaveBeenCalled();
    });

    // Requirement 12.3: Missing DATABASE_URL returns error
    it('returns error when DATABASE_URL is not set', async () => {
      vi.stubEnv('DATABASE_URL', '');
      const { registerArticleForTracking } = await import('../handlers/altus-performance-tracker.js');

      const result = await registerArticleForTracking({
        articleUrl: 'https://altwire.net/test/',
      });

      expect(result).toEqual({ error: 'Database not configured' });
    });

    // Requirement 12.2: ON CONFLICT idempotence
    it('calls pool.query with INSERT ... ON CONFLICT for idempotent upsert', async () => {
      vi.stubEnv('DATABASE_URL', 'postgres://localhost/test');
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const { registerArticleForTracking } = await import('../handlers/altus-performance-tracker.js');
      const result = await registerArticleForTracking({
        articleUrl: 'https://altwire.net/article/',
        wpPostId: 42,
        publishedAt: '2025-01-15T12:00:00Z',
        sourceQuery: 'weather station review',
      });

      expect(result.success).toBe(true);
      expect(result.article_url).toBe('https://altwire.net/article');

      // Verify the SQL uses ON CONFLICT
      const sql = mockQuery.mock.calls[0][0];
      expect(sql).toContain('INSERT INTO altus_article_assignments');
      expect(sql).toContain('ON CONFLICT');

      // Verify normalized URL was passed
      const params = mockQuery.mock.calls[0][1];
      expect(params[0]).toBe('https://altwire.net/article');
      expect(params[1]).toBe(42);
      expect(params[3]).toBe('weather station review');
    });
  });

  describe('runPerformanceSnapshotCron', () => {
    // Requirement 11.5: Cron inserts zero-value rows for partial GSC data
    it('inserts zero-value snapshot rows when GSC returns no data for an article', async () => {
      vi.stubEnv('DATABASE_URL', 'postgres://localhost/test');

      // Query altus_article_assignments — one article published 10 days ago
      const tenDaysAgo = new Date();
      tenDaysAgo.setDate(tenDaysAgo.getDate() - 10);
      mockQuery.mockResolvedValueOnce({
        rows: [
          { article_url: 'https://altwire.net/old-article', wp_post_id: 99, assigned_at: tenDaysAgo.toISOString() },
        ],
      });

      // Query existing snapshots for this article — none exist
      mockQuery.mockResolvedValueOnce({ rows: [] });

      // GSC returns no data (partial data scenario) for each eligible snapshot
      mockGetPagePerformance.mockResolvedValue({
        pageUrl: 'https://altwire.net/old-article',
        clicks: 0,
        impressions: 0,
        ctr: 0,
        position: null,
        note: 'No GSC data for this URL',
      });

      // Upsert calls succeed
      mockQuery.mockResolvedValue({ rows: [] });

      const { runPerformanceSnapshotCron } = await import('../handlers/altus-performance-tracker.js');
      await runPerformanceSnapshotCron();

      // Find INSERT INTO altus_article_performance calls
      const insertCalls = mockQuery.mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].includes('INSERT INTO altus_article_performance')
      );

      // Should have inserted snapshot rows (72h and 7d eligible for 10-day-old article)
      expect(insertCalls.length).toBeGreaterThanOrEqual(1);

      // Verify zero values were inserted
      for (const call of insertCalls) {
        const params = call[1];
        // clicks = 0, impressions = 0, ctr = 0
        expect(params[4]).toBe(0); // clicks
        expect(params[5]).toBe(0); // impressions
        expect(params[6]).toBe(0); // ctr
      }
    });
  });
});
