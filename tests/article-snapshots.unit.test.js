import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const query = vi.fn();
vi.mock('../lib/altus-db.js', () => ({ default: { query: (...args) => query(...args) } }));

import { dueCheckpoints, localDate, median, percentileOf, runArticleSnapshots } from '../handlers/altus-article-snapshots.js';

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
