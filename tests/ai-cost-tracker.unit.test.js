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

describe('ai-cost-tracker', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    mockQuery.mockReset();
  });

  describe('logAiUsage', () => {
    it('silently returns when DATABASE_URL is not set', async () => {
      vi.stubEnv('DATABASE_URL', '');
      const { logAiUsage } = await import('../lib/ai-cost-tracker.js');

      await expect(
        logAiUsage('test_tool', 'claude-haiku-4-5', { input_tokens: 100, output_tokens: 50 }),
      ).resolves.toBeUndefined();

      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('never throws even when pool.query rejects', async () => {
      vi.stubEnv('DATABASE_URL', 'postgres://localhost/test');
      mockQuery.mockRejectedValueOnce(new Error('connection refused'));

      const { logAiUsage } = await import('../lib/ai-cost-tracker.js');

      await expect(
        logAiUsage('test_tool', 'claude-haiku-4-5', { input_tokens: 100, output_tokens: 50 }),
      ).resolves.not.toThrow();
    });

    it('calls pool.query with correct parameters when DATABASE_URL is set', async () => {
      vi.stubEnv('DATABASE_URL', 'postgres://localhost/test');
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const { logAiUsage } = await import('../lib/ai-cost-tracker.js');

      await logAiUsage('get_story_opportunities', 'claude-haiku-4-5', {
        input_tokens: 200,
        output_tokens: 100,
      });

      expect(mockQuery).toHaveBeenCalledOnce();
      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('INSERT INTO ai_usage');
      expect(params[0]).toBe('get_story_opportunities');
      expect(params[1]).toBe('claude-haiku-4-5');
      expect(params[2]).toBe(200);
      expect(params[3]).toBe(100);
      expect(params[4]).toBe(0);
      expect(params[5]).toBe(0);
      expect(typeof params[6]).toBe('number'); // estimated_cost_usd
      expect(params[6]).toBeGreaterThan(0);
      expect(params[7]).toBe(false);
    });

    it('logs cache tokens and applies batch discount', async () => {
      vi.stubEnv('DATABASE_URL', 'postgres://localhost/test');
      mockQuery.mockResolvedValue({ rows: [] });

      const { logAiUsage } = await import('../lib/ai-cost-tracker.js');

      await logAiUsage(
        'batch_tool',
        'claude-fable-5',
        {
          input_tokens: 1000,
          output_tokens: 100,
          cache_read_input_tokens: 500,
          cache_creation_input_tokens: 200,
        },
        { isBatch: true },
      );

      const [, params] = mockQuery.mock.calls[0];
      expect(params[4]).toBe(500);
      expect(params[5]).toBe(200);
      expect(params[6]).toBeCloseTo(0.009, 8);
      expect(params[7]).toBe(true);
    });
  });

  describe('5.5-generation pricing', () => {
    it('prices claude-fable-5-1 with its own row and cache-read multiplier', async () => {
      vi.stubEnv('DATABASE_URL', 'postgres://localhost/test');
      mockQuery.mockResolvedValue({ rows: [] });
      const { logAiUsage } = await import('../lib/ai-cost-tracker.js');

      await logAiUsage('t', 'claude-fable-5-1', {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 1_000_000,
      });

      // $10/MTok input x 0.025 cache-read multiplier (the old fable-5 row used 0.10).
      expect(mockQuery.mock.calls[0][1][6]).toBeCloseTo(0.25, 8);
    });

    it('prices claude-haiku-5-5 at the <=100K-token tier, not the Haiku 4.5 row', async () => {
      vi.stubEnv('DATABASE_URL', 'postgres://localhost/test');
      mockQuery.mockResolvedValue({ rows: [] });
      const { logAiUsage } = await import('../lib/ai-cost-tracker.js');

      await logAiUsage('t', 'claude-haiku-5-5', { input_tokens: 1_000_000, output_tokens: 1_000_000 });

      expect(mockQuery.mock.calls[0][1][6]).toBeCloseTo(0.60, 8);
    });
  });

  describe('initAiUsageSchema', () => {
    it('calls pool.query with CREATE TABLE IF NOT EXISTS', async () => {
      vi.stubEnv('DATABASE_URL', 'postgres://localhost/test');
      mockQuery.mockResolvedValue({ rows: [] });

      const { initAiUsageSchema } = await import('../lib/ai-cost-tracker.js');

      await initAiUsageSchema();

      const createTableCall = mockQuery.mock.calls.find(([sql]) =>
        sql.includes('CREATE TABLE IF NOT EXISTS ai_usage'),
      );
      expect(createTableCall).toBeDefined();
    });
  });
});
