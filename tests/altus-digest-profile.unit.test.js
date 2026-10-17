import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../handlers/altwire-matomo-client.js', () => ({
  getTrafficSummary: vi.fn(async () => ({ nb_visits: 10 })),
  getSiteSearchKeywords: vi.fn(async () => [{ label: 'deftones', nb_visits: 7 }]),
}));
vi.mock('../handlers/altus-story-scan.js', () => ({
  listStoryQueue: vi.fn(async () => ({ opportunities: [{ id: 1, query: 'gamma mini synth' }], open_count: 4, last_scan_at: '2026-10-15T09:00:00Z' })),
}));
vi.mock('../handlers/altus-history.js', () => ({
  getAnalyticsHistory: vi.fn(async () => ({ months: [], last_complete_month: { month: '2026-09' }, computed_at: 't' })),
  summarizeHistory: vi.fn((h) => ({ last_complete_month: h.last_complete_month })),
}));
vi.mock('../handlers/altus-opportunity-queue.js', () => ({ listStoryOpportunityQueue: vi.fn(async () => []) }));
vi.mock('../lib/wp-client.js', () => ({
  getSeoQueue: vi.fn(async () => ({ items: [
    { page_url: 'https://altwire.net/microfreak/', query: 'microfreak review', reason_code: 'ctr_gap', source: null, first_seen: '2999-01-01 08:00:00', notes: 'Lead with the model name' },
  ] })),
}));
vi.mock('../handlers/altus-traffic-patterns.js', () => ({
  getTrafficPatterns: vi.fn(async () => ({ latest_day: { date: '2026-10-14', spike: true } })),
  summarizePatterns: vi.fn((r) => ({ latest_day: r.latest_day, typical_spike: { days_peak_to_normal: 3 } })),
}));
vi.mock('../handlers/altus-digest-analytics.js', () => ({ buildAnalyticsSnapshot: vi.fn(async () => ({ matomo: {} })) }));

// Every agent_memory read returns a stored Hal-era snapshot.
vi.mock('../lib/altus-db.js', () => ({
  default: {
    query: vi.fn(async (sql) => {
      if (/LIKE 'altus:news_alert/.test(sql)) return { rows: [] };
      if (/LIKE 'hal:altwire:analytics/.test(sql)) return { rows: [] };
      return { rows: [{ value: JSON.stringify({ period: '7d', generated_at: '2026-10-10T08:00:00Z' }) }] };
    }),
  },
}));

const STALE = ['fresh_traffic', 'fresh_top_articles', 'fresh_gsc_opps', 'editorial_synthesis'];

describe('morning digest by profile', () => {
  const saved = process.env.ALTUS_PROFILE;
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => {
    if (saved === undefined) delete process.env.ALTUS_PROFILE;
    else process.env.ALTUS_PROFILE = saved;
  });

  it('in core: no Hal-era snapshots, history, or watch-list alerts; live site search; the story queue', async () => {
    process.env.ALTUS_PROFILE = 'core';
    const { getAltwireMorningDigest } = await import('../handlers/altus-digest.js');
    const digest = await getAltwireMorningDigest();
    for (const key of [...STALE, 'historical', 'news_alerts']) expect(digest, key).not.toHaveProperty(key);
    expect(digest.site_search_keywords).toMatchObject({ source: 'Matomo', keywords: [{ keyword: 'deftones', searches: 7 }] });
    expect(digest.story_opportunities).toEqual({ open_count: 4, last_scan_at: '2026-10-15T09:00:00Z', top: [{ id: 1, query: 'gamma mini synth' }] });
    expect(digest.analytics).toEqual({ matomo: {} });
    expect(digest.history).toEqual({ last_complete_month: { month: '2026-09' } });
    expect(digest.traffic_context).toEqual({ latest_day: { date: '2026-10-14', spike: true }, typical_spike: { days_peak_to_normal: 3 } });
    expect(digest.seo_queue).toMatchObject({ waiting: 1, new_since_yesterday: 1, items: [{ query: 'microfreak review', reason: 'seen but rarely clicked', queued_by: 'person' }] });
  });

  it('keeps them in the legacy profile, where the old mailer reads them', async () => {
    delete process.env.ALTUS_PROFILE;
    const { getAltwireMorningDigest } = await import('../handlers/altus-digest.js');
    const digest = await getAltwireMorningDigest();
    for (const key of STALE) expect(digest[key], key).toMatchObject({ period: '7d' });
    expect(digest).not.toHaveProperty('seo_queue');
    expect(digest).not.toHaveProperty('traffic_context');
  });
});
