import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();
vi.mock('../lib/altus-db.js', () => ({
  default: { query: mockQuery },
  hasDbConfig: () => Boolean(process.env.ALTWIRE_DATABASE_URL || process.env.DATABASE_URL),
}));

vi.mock('../logger.js', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

function mockExistingTable() {
  mockQuery.mockResolvedValueOnce({ rows: [{ table_name: 'table' }] });
}

describe('altus-data-health', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    mockQuery.mockReset();
  });

  it('reports empty Phase 1-3 backing tables and cache as warnings', async () => {
    vi.stubEnv('ALTWIRE_DATABASE_URL', 'postgres://localhost/test');

    mockExistingTable();
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: 0 }] })
      .mockResolvedValueOnce({ rows: [{ latest_at: null }] });

    mockExistingTable();
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: 0 }] })
      .mockResolvedValueOnce({ rows: [{ latest_at: null }] });

    mockExistingTable();
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: 0 }] })
      .mockResolvedValueOnce({ rows: [{ latest_at: null }] });

    mockExistingTable();
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const { getAltusDataHealth } = await import('../handlers/altus-data-health.js');
    const result = await getAltusDataHealth();

    expect(result.ok).toBe(false);
    expect(result.checks.story_queue.count).toBe(0);
    expect(result.checks.active_watch_subjects.count).toBe(0);
    expect(result.checks.article_performance.count).toBe(0);
    expect(result.checks.story_opportunities_cache.cached).toBe(false);
    expect(result.warnings).toEqual([
      expect.stringContaining('altus_story_opportunities is empty'),
      expect.stringContaining('altus_watch_list has no active subjects'),
      expect.stringContaining('altus_article_performance is empty'),
      expect.stringContaining('No altus:story_opportunities cache exists'),
    ]);
  });

  it('reports a populated data plane as ok', async () => {
    vi.stubEnv('ALTWIRE_DATABASE_URL', 'postgres://localhost/test');

    mockExistingTable();
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: 4 }] })
      .mockResolvedValueOnce({ rows: [{ latest_at: '2026-06-17T01:00:00.000Z' }] });

    mockExistingTable();
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: 3 }] })
      .mockResolvedValueOnce({ rows: [{ latest_at: '2026-06-17T01:00:00.000Z' }] });

    mockExistingTable();
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: 7 }] })
      .mockResolvedValueOnce({ rows: [{ latest_at: '2026-06-17T01:00:00.000Z' }] });

    mockExistingTable();
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          value: JSON.stringify({ opportunities: [{ query: 'radiohead' }] }),
          updated_at: '2026-06-17T01:00:00.000Z',
        },
      ],
    });

    const { getAltusDataHealth } = await import('../handlers/altus-data-health.js');
    const result = await getAltusDataHealth();

    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.checks.story_opportunities_cache.opportunities).toBe(1);
  });
});
