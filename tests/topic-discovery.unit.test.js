import { describe, it, expect, vi, beforeEach } from 'vitest';

function isoDateOffset(daysBack) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysBack);
  return d.toISOString().slice(0, 10);
}

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
const mockGetOpportunityZoneQueries = vi.fn();
vi.mock('../handlers/altwire-gsc-client.js', () => ({
  getOpportunityZoneQueries: mockGetOpportunityZoneQueries,
}));

// Mock archive search
const mockSearchAltwireArchive = vi.fn();
vi.mock('../handlers/altus-search.js', () => ({
  searchAltwireArchive: mockSearchAltwireArchive,
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

// Mock editorial helpers — prevents pool.query calls before the cache lookup
vi.mock('../lib/editorial-helpers.js', () => ({
  loadEditorialContext: vi.fn().mockResolvedValue(null),
  loadTopicTrends: vi.fn().mockResolvedValue(null),
  scoreEditorialAffinity: vi.fn().mockReturnValue({ affinity: 1.0 }),
}));

describe('altus-topic-discovery', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    mockQuery.mockReset();
    mockGetOpportunityZoneQueries.mockReset();
    mockSearchAltwireArchive.mockReset();
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

    // Requirement 6.10: Missing database URL returns error
    it('returns error when no Altus database env is set', async () => {
      vi.stubEnv('DATABASE_URL', '');
      vi.stubEnv('ALTWIRE_DATABASE_URL', '');
      const { getStoryOpportunities } = await import('../handlers/altus-topic-discovery.js');

      const result = await getStoryOpportunities();

      expect(result).toEqual({ error: 'Database not configured' });
    });

    // Requirement 6.7: Cache hit returns cached result
    it('returns cached result without calling GSC when cache hit', async () => {
      vi.stubEnv('ALTWIRE_DATABASE_URL', 'postgres://localhost/test');
      const cachedData = {
        opportunities: [{ query: 'cached query', score: 100 }],
        pitches: 'Cached pitches',
        cached: false,
      };
      mockQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
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

    it('uses the shared lag-aware GSC window by default', async () => {
      vi.stubEnv('DATABASE_URL', 'postgres://localhost/test');
      mockQuery.mockResolvedValue({ rows: [] });
      mockGetOpportunityZoneQueries.mockResolvedValueOnce({
        rows: [
          { keys: ['weather station review', '/reviews/'], impressions: 800, clicks: 40, position: 12 },
        ],
      });
      mockSearchAltwireArchive.mockResolvedValueOnce({
        results: [{ weighted_score: 0.1 }],
      });
      mockSynthesizePitches.mockResolvedValueOnce({
        pitches: 'Pitch',
        model: 'claude-haiku-4-5',
        usage: { input_tokens: 10, output_tokens: 20 },
      });
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const { getStoryOpportunities } = await import('../handlers/altus-topic-discovery.js');
      const result = await getStoryOpportunities();

      expect(mockGetOpportunityZoneQueries).toHaveBeenCalledWith(
        isoDateOffset(31),
        isoDateOffset(3)
      );
      expect(result.date_range).toEqual({
        start: isoDateOffset(31),
        end: isoDateOffset(3),
      });
    });

    // Requirement 6.8: Zero GSC rows returns empty opportunities with note
    it('returns empty opportunities with note when GSC returns zero rows', async () => {
      vi.stubEnv('ALTWIRE_DATABASE_URL', 'postgres://localhost/test');
      mockQuery.mockResolvedValue({ rows: [] });
      // GSC returns zero rows
      mockGetOpportunityZoneQueries.mockResolvedValueOnce({
        rows: [],
      });

      const { getStoryOpportunities } = await import('../handlers/altus-topic-discovery.js');
      const result = await getStoryOpportunities();

      expect(result.opportunities).toEqual([]);
      expect(result.note).toContain('No queries found');
      expect(result.note).toContain('position 5-30');
      expect(mockSearchAltwireArchive).not.toHaveBeenCalled();
      expect(mockSynthesizePitches).not.toHaveBeenCalled();
    });

    it('skips cache reads when refresh is requested', async () => {
      vi.stubEnv('DATABASE_URL', 'postgres://localhost/test');
      mockQuery.mockResolvedValue({ rows: [] });
      mockGetOpportunityZoneQueries.mockResolvedValueOnce({
        rows: [
          { keys: ['weather station review', '/reviews/'], impressions: 800, clicks: 40, position: 12 },
        ],
      });
      mockSearchAltwireArchive.mockResolvedValueOnce({
        results: [{ weighted_score: 0.1 }],
      });
      mockSynthesizePitches.mockResolvedValueOnce({
        pitches: 'Pitch',
        model: 'claude-haiku-4-5',
        usage: { input_tokens: 10, output_tokens: 20 },
      });

      const { getStoryOpportunities } = await import('../handlers/altus-topic-discovery.js');
      const result = await getStoryOpportunities({ refresh: true });

      expect(result.cached).toBe(false);
      expect(mockGetOpportunityZoneQueries).toHaveBeenCalledTimes(1);
      expect(
        mockQuery.mock.calls.some(([sql, params]) =>
          typeof sql === 'string' &&
          sql.includes('SELECT value FROM agent_memory') &&
          Array.isArray(params) &&
          params[0] === 'altus' &&
          typeof params[1] === 'string' &&
          params[1].startsWith('altus:story_opportunities:')
        )
      ).toBe(false);
      expect(mockQuery.mock.calls.at(-1)?.[0]).toContain('INSERT INTO agent_memory');
    });

    // Haiku failure still returns opportunities
    it('returns opportunities without pitches when synthesizePitches throws', async () => {
      vi.stubEnv('ALTWIRE_DATABASE_URL', 'postgres://localhost/test');
      mockQuery.mockResolvedValue({ rows: [] });
      // GSC returns one row
      mockGetOpportunityZoneQueries.mockResolvedValueOnce({
        rows: [
          { keys: ['weather station review', '/reviews/'], impressions: 800, clicks: 40, position: 12 },
        ],
      });
      // Archive search returns low coverage
      mockSearchAltwireArchive.mockResolvedValueOnce({
        results: [{ weighted_score: 0.1 }],
      });
      // Haiku fails
      mockSynthesizePitches.mockRejectedValueOnce(new Error('Haiku API timeout'));

      const { getStoryOpportunities } = await import('../handlers/altus-topic-discovery.js');
      const result = await getStoryOpportunities();

      expect(result.opportunities).toBeInstanceOf(Array);
      expect(result.opportunities.length).toBe(1);
      expect(result.opportunities[0].query).toBe('weather station review');
      expect(result.pitches).toBe('');
      expect(mockLogAiUsage).not.toHaveBeenCalled();
    });

    it('accepts ALTWIRE_DATABASE_URL as sufficient database config', async () => {
      vi.stubEnv('DATABASE_URL', '');
      vi.stubEnv('ALTWIRE_DATABASE_URL', 'postgres://localhost/test');
      mockQuery.mockResolvedValueOnce({ rows: [] });
      mockGetOpportunityZoneQueries.mockResolvedValueOnce({ rows: [] });

      const { getStoryOpportunities } = await import('../handlers/altus-topic-discovery.js');
      const result = await getStoryOpportunities();

      expect(result.error).toBeUndefined();
      expect(mockGetOpportunityZoneQueries).toHaveBeenCalled();
    });
  });
});
