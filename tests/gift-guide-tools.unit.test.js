import { describe, expect, it, vi } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { buildScoreRow } from '../lib/review-scores.js';
import {
  SEASONAL_TERMS,
  buildSeasonalReport,
  getSeasonalComparison,
  resolveSeasonWindow,
} from '../handlers/altus-seasonal.js';

const review = { wp_id: 7, content_hash: 'abc' };

describe('buildScoreRow', () => {
  it('stores a product score with a rounded overall and clamped ratings', () => {
    const row = buildScoreRow(review, {
      type: 'product',
      product_type: 'recording',
      ratings: { Sound: 9, Build: 8, Workflow: 7.6, Features: 12, Value: 'n/a' },
      pros: ['Clean preamps'],
      cons: ['Pricey'],
      copy_issues: [],
      categorization_issue: null,
    });
    expect(row).toMatchObject({ wp_id: 7, content_hash: 'abc', status: 'scored', product_type: 'recording' });
    expect(row.ratings).toEqual({ Sound: 9, Build: 8, Workflow: 8, Features: 10 });
    expect(row.overall).toBe(8.8);
    expect(row.pros).toEqual(['Clean preamps']);
  });

  it('falls back to other for an unknown product type', () => {
    expect(buildScoreRow(review, { type: 'product', product_type: 'synth', ratings: {} })).toMatchObject({
      product_type: 'other',
      overall: null,
    });
  });

  it('records concert reviews and errors without ratings', () => {
    expect(buildScoreRow(review, { type: 'concert' })).toMatchObject({ status: 'concert', ratings: null });
    expect(buildScoreRow(review, null, 'rate limited')).toMatchObject({ status: 'error', error: 'rate limited' });
    expect(buildScoreRow(review, { type: 'weird' })).toMatchObject({ status: 'error' });
  });
});

describe('resolveSeasonWindow', () => {
  const oct2026 = new Date('2026-10-15T12:00:00Z');

  it('defaults to the most recent holiday season that has ended', () => {
    expect(resolveSeasonWindow({}, oct2026)).toEqual({ year: 2025, startDate: '2025-11-01', endDate: '2025-12-31' });
    expect(resolveSeasonWindow({}, new Date('2027-01-05T00:00:00Z')).year).toBe(2026);
  });

  it('supports custom and year-wrapping windows', () => {
    expect(resolveSeasonWindow({ year: 2025, start_md: '12-15', end_md: '01-10' }, oct2026)).toEqual({
      year: 2025, startDate: '2025-12-15', endDate: '2026-01-10',
    });
  });

  it('rejects malformed dates', () => {
    expect(() => resolveSeasonWindow({ start_md: '2025-11-01' }, oct2026)).toThrow(/MM-DD/);
  });
});

describe('SEASONAL_TERMS', () => {
  it('matches holiday and gift phrasing but not ordinary titles', () => {
    for (const q of ['gift ideas for guitarists', 'best plugins 2025', 'black friday audio interface deals', 'christmas albums']) {
      expect(SEASONAL_TERMS.test(q), q).toBe(true);
    }
    for (const q of ['tool fear inoculum review', 'live review: the cure']) {
      expect(SEASONAL_TERMS.test(q), q).toBe(false);
    }
  });
});

describe('buildSeasonalReport', () => {
  const guide = 'https://altwire.net/holiday-gift-guide-2025/';
  const review2 = 'https://altwire.net/review-focusrite-scarlett/';

  const report = buildSeasonalReport({
    window: { year: 2025 },
    seasonQueries: [
      { keys: ['gift ideas for musicians'], clicks: 40, impressions: 2000, ctr: 0.02, position: 8.24 },
      { keys: ['focusrite scarlett review'], clicks: 90, impressions: 900, ctr: 0.1, position: 3 },
    ],
    seasonPages: [
      { keys: [guide], clicks: 55, impressions: 3000, position: 7.1 },
      { keys: [review2], clicks: 5, impressions: 100, position: 12 },
      { keys: ['https://altwire.net/news/'], clicks: 50, impressions: 400, position: 4 },
    ],
    seasonArticles: [{ url: 'https://altwire.net/holiday-gift-guide-2025', pageviews: 800 }],
    currentPages: [{ keys: ['https://altwire.net/holiday-gift-guide-2025'], clicks: 3, position: 18.44 }],
    articles: new Map([
      ['https://altwire.net/holiday-gift-guide-2025', { title: 'Holiday Gift Guide 2025', published_at: '2025-11-20' }],
      ['https://altwire.net/review-focusrite-scarlett', { title: 'Review: Focusrite Scarlett', published_at: '2024-03-01' }],
    ]),
  });

  it('flags seasonal queries and formats CTR as a percentage', () => {
    expect(report.seasonal_queries.map((q) => q.query)).toEqual(['gift ideas for musicians']);
    expect(report.top_queries[0]).toMatchObject({ ctr: 2, position: 8.2 });
  });

  it('joins season traffic, current search, and archive metadata by normalized URL', () => {
    const page = report.top_pages[0];
    expect(page).toMatchObject({
      title: 'Holiday Gift Guide 2025',
      season_clicks: 55,
      season_pageviews: 800,
      last_28d_clicks: 3,
      last_28d_position: 18.4,
      seasonal: true,
      refresh_candidate: true,
    });
    expect(report.refresh_candidates.map((p) => p.title)).toEqual(['Holiday Gift Guide 2025']);
  });

  it('keeps listing pages out of top_pages', () => {
    expect(report.top_pages.map((p) => p.url)).not.toContain('https://altwire.net/news/');
    expect(report.top_pages.find((p) => p.title?.includes('Focusrite'))).toMatchObject({ refresh_candidate: false, last_28d_clicks: 0 });
  });

  it('narrows lists with query_contains', () => {
    const narrowed = buildSeasonalReport({
      window: {},
      seasonQueries: [{ keys: ['vinyl gifts'], clicks: 1, impressions: 10, ctr: 0.1, position: 5 }, { keys: ['amp review'], clicks: 1, impressions: 10, ctr: 0.1, position: 5 }],
      queryContains: 'VINYL',
    });
    expect(narrowed.top_queries.map((q) => q.query)).toEqual(['vinyl gifts']);
  });
});

describe('getSeasonalComparison', () => {
  it('skips Search Console for seasons older than its retention and says so', async () => {
    const gsc = vi.fn(async () => ({ rows: [] }));
    const result = await getSeasonalComparison(
      { year: 2023 },
      { gsc, matomoTopArticles: async () => [], articleLookup: async () => new Map(), now: new Date('2026-10-15T00:00:00Z') },
    );
    // Only the current 28-day page query runs.
    expect(gsc).toHaveBeenCalledTimes(1);
    expect(result.notes.join(' ')).toMatch(/16 months/);
    expect(result.window.gsc_start_date).toBeNull();
  });

  it('queries the season window in both sources and reports source errors', async () => {
    const gsc = vi.fn(async () => ({ rows: [] }));
    const matomo = vi.fn(async () => ({ error: 'matomo_down', message: 'timeout' }));
    const result = await getSeasonalComparison(
      {},
      { gsc, matomoTopArticles: matomo, articleLookup: async () => new Map(), now: new Date('2026-10-15T00:00:00Z') },
    );
    expect(gsc).toHaveBeenCalledWith('2025-11-01', '2025-12-31', { rowLimit: 1000, dimensions: ['query'] });
    expect(matomo).toHaveBeenCalledWith('range', '2025-11-01,2025-12-31', 300);
    expect(result.notes.join(' ')).toMatch(/Matomo unavailable: timeout/);
  });
});
