import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const query = vi.fn();
vi.mock('../lib/altus-db.js', () => ({ default: { query: (...args) => query(...args) } }));

import { buildHistory, refreshAnalyticsHistory, rollUpSearchByMonth, summarizeHistory } from '../handlers/altus-history.js';

function days(month, n, clicks, impressions, position) {
  return Array.from({ length: n }, (_, i) => ({ date: `${month}-${String(i + 1).padStart(2, '0')}`, clicks, impressions, position }));
}

describe('rollUpSearchByMonth', () => {
  it('sums by month, weights position by impressions, and flags incomplete months', () => {
    const out = rollUpSearchByMonth([
      { date: '2026-09-01', clicks: 10, impressions: 100, position: 10 },
      { date: '2026-09-02', clicks: 30, impressions: 300, position: 20 },
      ...days('2026-08', 31, 1, 10, 5),
    ]);
    expect(out['2026-09']).toEqual({ clicks: 40, impressions: 400, ctr_pct: 10, position: 17.5, days: 2, complete: false });
    expect(out['2026-08']).toMatchObject({ clicks: 31, impressions: 310, days: 31, complete: true });
  });
});

describe('buildHistory', () => {
  const matomo = {
    '2025-09': { visits: 800, pageviews: 1000, unique_visitors: 700 },
    '2026-08': { visits: 1100, pageviews: 1500, unique_visitors: 900 },
    '2026-09': { visits: 1000, pageviews: 1200, unique_visitors: 800 },
    '2026-10': { visits: 400, pageviews: 500, unique_visitors: 300 },
  };
  const search = rollUpSearchByMonth([
    ...days('2025-09', 20, 1, 10, 9), // incomplete: Search Console's oldest month
    ...days('2026-08', 31, 2, 20, 9),
    ...days('2026-09', 30, 3, 30, 8),
    ...days('2026-10', 12, 3, 30, 8),
  ]);

  it('lists months newest first and marks the current month partial', () => {
    const h = buildHistory(matomo, search, '2026-10');
    expect(h.months.map((m) => [m.month, m.partial])).toEqual([['2026-10', true], ['2026-09', false], ['2026-08', false], ['2025-09', false]]);
    expect(h.months[3].search).toMatchObject({ clicks: 20, partial_days: 20 });
  });

  it('compares the last complete month and nulls search YoY when either side is incomplete', () => {
    const h = buildHistory(matomo, search, '2026-10');
    expect(h.last_complete_month).toEqual({
      month: '2026-09',
      vs_previous_month: { pageviews_pct: -20, visits_pct: -9.1, search_clicks_pct: 45.2, search_impressions_pct: 45.2 },
      vs_year_earlier: { pageviews_pct: 20, visits_pct: 25, search_clicks_pct: null, search_impressions_pct: null },
    });
    expect(h.best_month).toEqual({ pageviews: { month: '2026-08', pageviews: 1500 }, search_clicks: { month: '2026-09', clicks: 90 } });
  });

  it('leaves 3-month YoY null when the year-earlier months are missing', () => {
    const h = buildHistory(matomo, search, '2026-10');
    expect(h.last_3_months.months).toEqual(['2026-07', '2026-08', '2026-09']);
    expect(h.last_3_months.vs_year_earlier.pageviews_pct).toBeNull();
  });

  it('summarizes recent months for the digest', () => {
    const s = summarizeHistory({ ...buildHistory(matomo, search, '2026-10'), computed_at: 't', note: 'n' }, { months: 2 });
    expect(s.recent_months).toEqual([
      { month: '2026-10', partial: true, pageviews: 500, visits: 400, search_clicks: 36, search_impressions: 360 },
      { month: '2026-09', pageviews: 1200, visits: 1000, search_clicks: 90, search_impressions: 900 },
    ]);
  });
});

describe('refreshAnalyticsHistory', () => {
  beforeEach(() => query.mockReset());

  it('keeps the last build when a source fails', async () => {
    const result = await refreshAnalyticsHistory({ deps: {
      matomo: async () => ({ '2026-09': { visits: 1, pageviews: 1 } }),
      gsc: async () => ({ error: 'gsc_api_error', message: 'quota' }),
    } });
    expect(result).toEqual({ error: 'Search Console: quota' });
    expect(query).not.toHaveBeenCalled();
  });

  it('requests 16 months of Search Console data ending 3 days ago and stores the build', async () => {
    query.mockResolvedValue({ rows: [{ computed_at: 'now' }] });
    const gsc = vi.fn(async () => ({ rows: days('2026-09', 30, 1, 10, 5) }));
    const result = await refreshAnalyticsHistory({
      deps: { matomo: async () => ({ '2026-09': { visits: 1, pageviews: 2 } }), gsc },
      now: new Date('2026-10-15T12:00:00Z'),
    });
    expect(gsc).toHaveBeenCalledWith('2025-06-01', '2026-10-12');
    expect(result.last_complete_month.month).toBe('2026-09');
    const upsert = query.mock.calls.find(([sql]) => /INSERT INTO altus_kv/.test(sql));
    expect(upsert[1][0]).toBe('analytics:monthly_history');
  });
});
