import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();
vi.mock('../lib/altus-db.js', () => ({
  default: { query: mockQuery },
  hasDbConfig: () => Boolean(process.env.ALTWIRE_DATABASE_URL || process.env.DATABASE_URL),
}));

const mockCreateAssignment = vi.fn();
vi.mock('../handlers/altus-writer.js', () => ({
  createAssignment: mockCreateAssignment,
}));

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('altus-opportunity-queue', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    mockQuery.mockReset();
    mockCreateAssignment.mockReset();
  });

  it('upserts story opportunities as durable pending queue items', async () => {
    vi.stubEnv('ALTWIRE_DATABASE_URL', 'postgres://localhost/test');
    mockQuery.mockResolvedValue({ rows: [] });

    const { upsertStoryOpportunityQueue } = await import('../handlers/altus-opportunity-queue.js');
    await upsertStoryOpportunityQueue({
      opportunities: [
        {
          query: 'nine inch nails tour',
          page: 'https://altwire.net/nin/',
          impressions: 1200,
          clicks: 24,
          position: 8.2,
          score: 940,
          coverageStatus: 'weak_coverage',
        },
      ],
      pitches: 'Cover NIN tour dates with an AltWire angle.',
    });

    const insertCall = mockQuery.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('INSERT INTO altus_story_opportunities')
    );
    expect(insertCall).toBeDefined();
    expect(insertCall[1][1]).toBe('nine inch nails tour');
    expect(insertCall[1][2]).toBe('https://altwire.net/nin/');
    expect(insertCall[1][4]).toBe('high');
    expect(insertCall[1][5]).toBe('weak_coverage');
  });

  it('lists queue rows in the chat UI opportunity shape', async () => {
    vi.stubEnv('ALTWIRE_DATABASE_URL', 'postgres://localhost/test');
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 12,
          topic: 'radiohead album news',
          url: null,
          suggested_angle: 'Explain why this matters to AltWire readers.',
          priority: 'medium',
          status: 'pending',
          source: 'gsc_opportunity_zone',
          coverage_status: 'no_coverage',
          impressions: 700,
          clicks: 10,
          position: 14.4,
          score: 410,
          discovered_at: new Date('2026-06-04T10:00:00.000Z'),
          assigned_at: null,
          assignment_id: null,
        },
      ],
    });

    const { listStoryOpportunityQueue } = await import('../handlers/altus-opportunity-queue.js');
    const result = await listStoryOpportunityQueue();

    expect(result.opportunities).toEqual([
      expect.objectContaining({
        id: 12,
        title: 'radiohead album news',
        topic: 'radiohead album news',
        priority: 'medium',
        urgency: 'medium',
        status: 'pending',
        source: 'GSC opportunity zone',
        coverage_status: 'no_coverage',
        impressions: 700,
        position: 14.4,
      }),
    ]);
  });

  it('can list assigned opportunities when status=all is requested', async () => {
    vi.stubEnv('ALTWIRE_DATABASE_URL', 'postgres://localhost/test');
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 14,
          topic: 'deftones festival set',
          url: 'https://altwire.net/deftones/',
          suggested_angle: 'Tie the set to AltWire live coverage.',
          priority: 'high',
          status: 'assigned',
          source: 'google_news',
          coverage_status: 'watch_list_match',
          impressions: 1200,
          clicks: 40,
          position: null,
          score: 220,
          discovered_at: new Date('2026-06-05T10:00:00.000Z'),
          assigned_at: new Date('2026-06-05T10:15:00.000Z'),
          assignment_id: 55,
        },
      ],
    });

    const { listStoryOpportunityQueue } = await import('../handlers/altus-opportunity-queue.js');
    const result = await listStoryOpportunityQueue({ status: 'all' });

    expect(result.opportunities).toEqual([
      expect.objectContaining({
        id: 14,
        status: 'assigned',
        source: 'Google News',
        assignment_id: 55,
      }),
    ]);
  });

  it('assigns an opportunity to the writer and marks it assigned', async () => {
    vi.stubEnv('ALTWIRE_DATABASE_URL', 'postgres://localhost/test');
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ id: 12, topic: 'radiohead album news', status: 'pending' }],
      })
      .mockResolvedValueOnce({
        rows: [{ id: 12, status: 'assigned', assignment_id: 44 }],
      });
    mockCreateAssignment.mockResolvedValue({
      success: true,
      assignment: { id: 44, topic: 'radiohead album news', status: 'outline_ready' },
    });

    const { assignStoryOpportunity } = await import('../handlers/altus-opportunity-queue.js');
    const result = await assignStoryOpportunity({ id: 12 });

    expect(mockCreateAssignment).toHaveBeenCalledWith({
      topic: 'radiohead album news',
      article_type: 'article',
    });
    expect(result).toEqual({
      success: true,
      opportunity_id: 12,
      assignment: { id: 44, topic: 'radiohead album news', status: 'outline_ready' },
    });
  });

  it('upserts Google News watch-list matches as high-priority queue items', async () => {
    vi.stubEnv('ALTWIRE_DATABASE_URL', 'postgres://localhost/test');
    mockQuery.mockResolvedValue({ rows: [] });

    const { upsertNewsOpportunityQueue } = await import('../handlers/altus-opportunity-queue.js');
    await upsertNewsOpportunityQueue({
      watch_list_matches: [
        {
          query: 'radiohead tour news',
          matched_items: ['Radiohead'],
          impressions: 300,
          clicks: 12,
        },
      ],
      news_pages: [{ keys: ['https://altwire.net/radiohead/'] }],
    });

    const insertCall = mockQuery.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('INSERT INTO altus_story_opportunities')
    );
    expect(insertCall).toBeDefined();
    expect(insertCall[1][1]).toBe('radiohead tour news');
    expect(insertCall[1][2]).toBe('https://altwire.net/radiohead/');
    expect(insertCall[0]).toContain("'google_news'");
    expect(insertCall[0]).toContain("'high'");
    expect(insertCall[0]).toContain("'watch_list_match'");
  });

  it('upserts clicked Google News pages even when the watch list is empty', async () => {
    vi.stubEnv('ALTWIRE_DATABASE_URL', 'postgres://localhost/test');
    mockQuery.mockResolvedValue({ rows: [] });

    const { upsertNewsOpportunityQueue } = await import('../handlers/altus-opportunity-queue.js');
    const result = await upsertNewsOpportunityQueue({
      watch_list_matches: [],
      news_pages: [
        {
          keys: ['https://altwire.net/die-antwoord-abuse-allegations-german/'],
          clicks: 38,
          impressions: 404,
          ctr: 0.094,
          position: 7.9,
        },
        {
          keys: ['https://altwire.net/no-click-news-page/'],
          clicks: 0,
          impressions: 200,
          ctr: 0,
          position: 12,
        },
      ],
    });

    const insertCalls = mockQuery.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('INSERT INTO altus_story_opportunities')
    );
    expect(result).toEqual({ success: true, upserted: 1 });
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0][1][1]).toBe('die antwoord abuse allegations german');
    expect(insertCalls[0][1][2]).toBe('https://altwire.net/die-antwoord-abuse-allegations-german/');
    expect(insertCalls[0][0]).toContain("'news_performer'");
  });
});
