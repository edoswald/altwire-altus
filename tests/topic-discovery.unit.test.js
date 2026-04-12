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
const mockGetOpportunityZoneQueries = vi.fn();
vi.mock('../handlers/altwire-gsc-client.js', () => ({
  getOpportunityZoneQueries: mockGetOpportunityZoneQueries,
}));

// Mock archive search
const mockSearchAltwareArchive = vi.fn();
vi.mock('../handlers/altus-search.js', () => ({
  searchAltwareArchive: mockSearchAltwareArchive,
}));

// Mock synthesizer
const mockSynthesizePitches = vi.fn();
vi.mock('../lib/synthesizer.js', () => ({
  synthesizePitches: mockSynthesizePitches,
}));

// Mock AI cost tracker
const mockLogAiUsage = vi.fn();
vi.mock('../lib/ai-cost-tracker.js', () => ({
  logAiUsage: mockLogAiUsage,
}));

describe('altus-topic-discovery', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    mockQuery.mockReset();
    mockGetOpportunityZoneQueries.mockReset();
    mockSearchAltwareArchive.mockReset();
    mockSynthesizePitches.mockReset();
    mockLogAiUsage.mockReset();
  });

  describe('getStoryOpportunities', () => {
    // Requirement 6.9: TEST_MODE returns mock data
    it('returns mock data with test_mode flag when TEST_MODE=true', async () => {
      vi.stubEnv('TEST_MODE', 'true');
      const { getStoryOpportunities } = await import('../handlers/altus-topic-discovery.js');

      const result = await getStoryOpportunities();

      expect(result.test_mode).toBe(true);
      expect(result.success).toBe(true);
      expect(result.opportunities).toBeInstanceOf(Array);
      expect(result.opportunities.length).toBeGreaterThan(0);
      expect(mockGetOpportunityZoneQueries).not.toHaveBeenCalled();
      expect(mockSynthesizePitches).not.toHaveBeenCalled();
    });

    // Requirement 6.10: Missing DATABASE_URL returns error
    it('returns error when DATABASE_URL is not set', async () => {
      vi.stubEnv('DATABASE_URL', '');
      const { getStoryOpportunities } = await import('../handlers/altus-topic-discovery.js');

      const result = await getStoryOpportunities();

      expect(result).toEqual({ error: 'Database not configured' });
    });

    // Requirement 6.7: Cache hit returns cached result
    it('returns cached result without calling GSC when cache hit', async () => {
      vi.stubEnv('DATABASE_URL', 'postgres://localhost/test');
      const cachedData = {
        opportunities: [{ query: 'cached query', score: 100 }],
        pitches: 'Cached pitches',
        cached: false,
      };
      mockQuery.mockResolvedValueOnce({
        rows: [{ value: JSON.stringify(cachedData) }],
      });

      const { getStoryOpportunities } = await import('../handlers/altus-topic-discovery.js');
      const result = await getStoryOpportunities();

      expect(result.cached).toBe(true);
      expect(result.opportunities).toEqual(cachedData.opportunities);
      expect(result.pitches).toBe('Cached pitches');
      expect(mockGetOpportunityZoneQueries).not.toHaveBeenCalled();
      expect(mockSynthesizePitches).not.toHaveBeenCalled();
    });

    // Requirement 6.8: Zero GSC rows returns empty opportunities with note
    it('returns empty opportunities with note when GSC returns zero rows', async () => {
      vi.stubEnv('DATABASE_URL', 'postgres://localhost/test');
      // Cache miss
      mockQuery.mockResolvedValueOnce({ rows: [] });
      // GSC returns zero rows
      mockGetOpportunityZoneQueries.mockResolvedValueOnce({
        rows: [],
      });

      const { getStoryOpportunities } = await import('../handlers/altus-topic-discovery.js');
      const result = await getStoryOpportunities();

      expect(result.opportunities).toEqual([]);
      expect(result.note).toContain('No queries found');
      expect(result.note).toContain('position 5-30');
      expect(mockSearchAltwareArchive).not.toHaveBeenCalled();
      expect(mockSynthesizePitches).not.toHaveBeenCalled();
    });

    // Haiku failure still returns opportunities
    it('returns opportunities without pitches when synthesizePitches throws', async () => {
      vi.stubEnv('DATABASE_URL', 'postgres://localhost/test');
      // Cache miss
      mockQuery.mockResolvedValueOnce({ rows: [] });
      // GSC returns one row
      mockGetOpportunityZoneQueries.mockResolvedValueOnce({
        rows: [
          { keys: ['weather station review', '/reviews/'], impressions: 800, clicks: 40, position: 12 },
        ],
      });
      // Archive search returns low coverage
      mockSearchAltwareArchive.mockResolvedValueOnce({
        results: [{ weighted_score: 0.1 }],
      });
      // Haiku fails
      mockSynthesizePitches.mockRejectedValueOnce(new Error('Haiku API timeout'));
      // Cache write succeeds
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const { getStoryOpportunities } = await import('../handlers/altus-topic-discovery.js');
      const result = await getStoryOpportunities();

      expect(result.opportunities).toBeInstanceOf(Array);
      expect(result.opportunities.length).toBe(1);
      expect(result.opportunities[0].query).toBe('weather station review');
      expect(result.pitches).toBe('');
      expect(mockLogAiUsage).not.toHaveBeenCalled();
    });
  });
});
