import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/altus-db.js', () => ({ default: { query: vi.fn() } }));
vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const {
  compareTotals,
  computeMovers,
  findNewOpportunityZoneEntries,
  pctChange,
  summarizeRecentArticles,
} = await import('../handlers/altus-digest-analytics.js');

describe('pctChange', () => {
  it('rounds to one decimal and returns null without a baseline', () => {
    expect(pctChange(110, 100)).toBe(10);
    expect(pctChange(1, 3)).toBe(-66.7);
    expect(pctChange(5, 0)).toBeNull();
    expect(pctChange('48%', 50)).toBeNull();
  });
});

describe('compareTotals', () => {
  it('pairs current and previous values per metric', () => {
    expect(compareTotals({ nb_visits: 120, bounce_rate: '50%' }, { nb_visits: 100 }, ['nb_visits', 'bounce_rate', 'nb_pageviews'])).toEqual({
      nb_visits: { current: 120, previous: 100, change_pct: 20 },
      bounce_rate: { current: '50%', previous: null, change_pct: null },
    });
    expect(compareTotals(null, null, ['nb_visits'])).toBeNull();
  });
});

describe('computeMovers', () => {
  const keyOf = (r) => r.url;
  it('ranks risers and fallers by absolute change, including rows on one side only', () => {
    const current = [{ url: 'a', hits: 500 }, { url: 'b', hits: 40 }, { url: 'new', hits: 300 }];
    const previous = [{ url: 'a', hits: 100 }, { url: 'b', hits: 400 }, { url: 'gone', hits: 90 }];
    const { risers, fallers } = computeMovers(current, previous, { keyOf, metric: 'hits' });
    expect(risers.map((m) => [m.key, m.change])).toEqual([['a', 400], ['new', 300]]);
    expect(fallers.map((m) => [m.key, m.change])).toEqual([['b', -360], ['gone', -90]]);
    expect(risers[1].change_pct).toBeNull();
  });

  it('drops rows below minVolume and tolerates missing inputs', () => {
    const { risers, fallers } = computeMovers([{ url: 'tiny', hits: 4 }], null, { keyOf, metric: 'hits', minVolume: 5 });
    expect(risers).toEqual([]);
    expect(fallers).toEqual([]);
  });
});

describe('findNewOpportunityZoneEntries', () => {
  it('returns queries absent last window, highest impressions first, deduped', () => {
    const current = [
      { keys: ['old query', '/a'], impressions: 900, position: 9 },
      { keys: ['fresh', '/b'], impressions: 200, position: 14.26 },
      { keys: ['fresh', '/c'], impressions: 100, position: 20 },
      { keys: ['bigger', '/d'], impressions: 500, position: 7 },
    ];
    const previous = [{ keys: ['old query', '/a'] }];
    expect(findNewOpportunityZoneEntries(current, previous)).toEqual([
      { query: 'bigger', page: '/d', impressions: 500, clicks: 0, position: 7 },
      { query: 'fresh', page: '/b', impressions: 200, clicks: 0, position: 14.3 },
    ]);
  });
});

describe('summarizeRecentArticles', () => {
  it('joins pageviews, search, and snapshots by normalized URL and sorts by views', () => {
    const rows = [
      { title: 'Quiet', url: 'https://altwire.net/quiet/', published_at: new Date('2026-10-10T00:00:00Z') },
      { title: 'Loud', url: 'https://altwire.net/loud/', published_at: '2026-10-09T00:00:00Z' },
    ];
    const result = summarizeRecentArticles(rows, {
      pageviewsByUrl: new Map([['https://altwire.net/loud', 900]]),
      searchByUrl: new Map([['https://altwire.net/loud', { clicks: 12, impressions: 300, position: 11.44 }]]),
      snapshotsByUrl: new Map([['https://altwire.net/quiet', { snapshot_type: '72h', clicks: 1, impressions: 20 }]]),
    });
    expect(result.map((r) => r.title)).toEqual(['Loud', 'Quiet']);
    expect(result[0]).toMatchObject({ pageviews: 900, search_clicks: 12, avg_position: 11.4, latest_snapshot: null });
    expect(result[1]).toMatchObject({ pageviews: 0, published_at: '2026-10-10T00:00:00.000Z', latest_snapshot: { type: '72h', clicks: 1, impressions: 20 } });
  });
});
