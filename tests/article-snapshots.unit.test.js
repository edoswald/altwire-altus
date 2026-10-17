import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const query = vi.fn();
vi.mock('../lib/altus-db.js', () => ({ default: { query: (...args) => query(...args) } }));

import { buildBenchmarks, dueCheckpoints, localDate, median, percentileOf, runArticleSnapshots, vsTypical } from '../handlers/altus-article-snapshots.js';

describe('article checkpoints', () => {
  it('uses the publish date in AltWire time', () => {
    expect(localDate('2026-10-01T02:30:00Z')).toBe('2026-09-30');
  });

  it('is due once the window plus the Search Console lag has passed', () => {
    const published = '2026-10-01T14:00:00Z';
    // 3-day window is Oct 1-3; due Oct 6.
    expect(dueCheckpoints(published, new Set(), '2026-10-05')).toEqual([]);
    expect(dueCheckpoints(published, new Set(), '2026-10-06')).toEqual([{ days: 3, start: '2026-10-01', end: '2026-10-03' }]);
    // 7-day window is Oct 1-7; due Oct 10. Already-taken checkpoints are skipped.
    expect(dueCheckpoints(published, new Set([3]), '2026-10-10').map((c) => c.days)).toEqual([7]);
    expect(dueCheckpoints(published, new Set(), '2026-11-02').map((c) => c.days)).toEqual([3, 7, 30]);
  });

  it('computes medians and percentiles', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeNull();
    expect(percentileOf([10, 20, 30, 40], 30)).toBe(75);
    expect(percentileOf([], 5)).toBeNull();
  });
});

describe('runArticleSnapshots', () => {
  beforeEach(() => query.mockReset());

  it('writes due checkpoints and skips (without writing) when a source fails', async () => {
    const inserts = [];
    query.mockImplementation(async (sql, params) => {
      if (/FROM altus_content/.test(sql)) {
        return { rows: [
          { wp_id: 1, title: 'Good', url: 'https://altwire.net/Good/', published_at: '2026-10-01T14:00:00Z' },
          { wp_id: 2, title: 'Broken', url: 'https://altwire.net/broken/', published_at: '2026-10-01T14:00:00Z' },
        ] };
      }
      if (/SELECT url_key, checkpoint_days/.test(sql)) return { rows: [{ url_key: 'https://altwire.net/good', checkpoint_days: 3 }] };
      if (/FROM altus_kv/.test(sql)) return { rows: [{ '?column?': 1 }] };
      if (/INSERT INTO altus_article_snapshots/.test(sql)) inserts.push(params);
      return { rows: [] };
    });
    const matomo = vi.fn(async (url) => (url.includes('broken') ? { error: 'matomo down' } : { pageviews: 120, visits: 100 }));
    const gsc = vi.fn(async () => ({ search: { clicks: 4, impressions: 300, position: 18.2 }, top_queries: [{ query: 'x' }], news: { clicks: 1, impressions: 40 } }));

    const result = await runArticleSnapshots({ deps: { matomo, gsc }, now: new Date('2026-10-10T12:00:00Z') });

    expect(result).toEqual({ posts: 2, taken: 1, skipped: 2 });
    expect(inserts).toHaveLength(1);
    const [url, key, wpId, , , days, start, end, pageviews, , clicks, , , newsClicks, , topQueries] = inserts[0];
    expect({ url, key, wpId, days, start, end, pageviews, clicks, newsClicks }).toEqual({
      url: 'https://altwire.net/Good/', key: 'https://altwire.net/good', wpId: 1, days: 7, start: '2026-10-01', end: '2026-10-07', pageviews: 120, clicks: 4, newsClicks: 1,
    });
    expect(JSON.parse(topQueries)).toEqual([{ query: 'x' }]);
  });
});

describe('backfill', () => {
  beforeEach(() => query.mockReset());

  it('tracks a year of posts on the first run and records it only when nothing failed', async () => {
    const seen = [];
    query.mockImplementation(async (sql, params) => {
      seen.push([sql, params]);
      if (/FROM altus_kv/.test(sql)) return { rows: [] };
      if (/FROM altus_content/.test(sql)) return { rows: [{ wp_id: 1, title: 'Old', url: 'https://altwire.net/old/', published_at: '2026-03-01T14:00:00Z' }] };
      return { rows: [] };
    });
    const matomo = vi.fn(async () => ({ pageviews: 10, visits: 8 }));
    const gsc = vi.fn(async () => ({ search: { clicks: 1, impressions: 5, position: 9 }, top_queries: [], news: { clicks: 0, impressions: 0 } }));
    const result = await runArticleSnapshots({ deps: { matomo, gsc }, now: new Date('2026-10-10T12:00:00Z') });
    expect(result).toEqual({ posts: 1, taken: 3, skipped: 0, backfill: true });
    expect(seen.find(([sql]) => /FROM altus_content/.test(sql))[1]).toEqual(['365']);
    expect(seen.some(([sql, p]) => /INSERT INTO altus_kv/.test(sql) && p[0] === 'snapshots:backfill')).toBe(true);
  });
});

describe('benchmarks by kind', () => {
  const rows = [
    ...Array.from({ length: 12 }, (_, i) => ({ checkpoint_days: 7, pageviews: (i + 1) * 100, search_clicks: i, title: `Band ${i} album review` })),
    ...Array.from({ length: 4 }, (_, i) => ({ checkpoint_days: 7, pageviews: (i + 1) * 10, search_clicks: 0, title: `Band ${i} interview` })),
  ];
  const benchmarks = buildBenchmarks(rows);

  it('compares reviews with reviews when there are enough', () => {
    const v = vsTypical({ checkpoint_days: 7, pageviews: 900, search_clicks: 5 }, 'review', benchmarks);
    expect(v).toMatchObject({ compared_with: 'reviews', articles_compared: 12, median_pageviews: 650, pageviews_percentile: 75 });
    expect(v.all_articles_pageviews_percentile).toBe(81);
  });

  it('falls back to all articles for a kind with few examples', () => {
    expect(vsTypical({ checkpoint_days: 7, pageviews: 30, search_clicks: 0 }, 'interview', benchmarks)).toMatchObject({ compared_with: 'all articles', articles_compared: 16 });
    expect(vsTypical({ checkpoint_days: 30, pageviews: 30, search_clicks: 0 }, 'review', benchmarks)).toBeNull();
  });
});
