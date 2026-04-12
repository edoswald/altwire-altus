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
      expect(typeof params[4]).toBe('number'); // estimated_cost_usd
      expect(params[4]).toBeGreaterThan(0);
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
