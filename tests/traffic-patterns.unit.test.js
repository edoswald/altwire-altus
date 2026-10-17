import { describe, expect, it, vi } from 'vitest';

vi.mock('../logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../lib/altus-db.js', () => ({ default: { query: vi.fn() } }));

import {
  addDays,
  ageBucket,
  analyzeTraffic,
  articleKind,
  findEpisodes,
  markSpikes,
  mergeByPage,
  summarizePatterns,
  urlKey,
} from '../handlers/altus-traffic-patterns.js';

const START = '2025-10-01';
const TODAY = '2026-10-17';
const DAYS = 380;
const dates = Array.from({ length: DAYS }, (_, i) => addDays(START, i));
// Weekends run 20% lower; one spike starts on day 300 and fades over 3 days.
const weekendFactor = (d) => ([0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay()) ? 0.8 : 1);
const SPIKE = { [dates[300]]: 4, [dates[301]]: 2.5, [dates[302]]: 1.8 };
const visitsOn = (d) => Math.round(1000 * weekendFactor(d) * (SPIKE[d] ?? 1));

describe('helpers', () => {
  it('keys URLs the same way whatever the source wrote', () => {
    expect(urlKey('https://www.AltWire.net/deftones-review/?utm=x')).toBe('altwire.net/deftones-review');
    expect(urlKey('http://altwire.net/deftones-review/amp')).toBe('altwire.net/deftones-review');
    expect(urlKey('')).toBeNull();
  });

  it('merges variant URLs before upserting', () => {
    const merged = mergeByPage([
      { date: '2026-10-01', url: 'https://altwire.net/a/', pageviews: 3 },
      { date: '2026-10-01', url: 'http://altwire.net/a?x=1', pageviews: 2 },
      { date: '2026-10-02', url: 'https://altwire.net/a/', pageviews: 1 },
    ], { pageviews: 'pageviews' });
    expect(merged).toEqual([
      { date: '2026-10-01', url_key: 'altwire.net/a', pageviews: 5 },
      { date: '2026-10-02', url_key: 'altwire.net/a', pageviews: 1 },
    ]);
  });

  it('guesses the article kind from categories and title', () => {
    expect(articleKind({ title: 'Arturia MicroFreak Review', categories: ['Gear'] })).toBe('review');
    expect(articleKind({ title: 'Chino Moreno talks the new record', categories: [] })).toBe('interview');
    expect(articleKind({ title: 'Deftones at the Forum', categories: ['Live Photos'] })).toBe('live');
    expect(articleKind({ title: 'Tour dates announced', categories: ['News'] })).toBe('news');
    expect(articleKind({ title: 'x', content_type: 'gallery' })).toBe('live');
    expect(articleKind({ title: 'Something else' })).toBe('other');
    expect([ageBucket(0), ageBucket(6), ageBucket(7), ageBucket(200), ageBucket(400), ageBucket(null)])
      .toEqual(['fresh', 'fresh', 'recent', 'this_year', 'archive', 'not_article']);
  });
});

describe('spikes', () => {
  const { days, weekdayFactors } = markSpikes(dates.map((d) => ({ date: d, value: visitsOn(d) })));

  it('learns the weekday pattern so a normal weekend is not a drop and a weekday is not a spike', () => {
    expect(weekdayFactors[6] / weekdayFactors[1]).toBeCloseTo(0.8, 2);
    expect(days.filter((d) => d.spike).map((d) => d.date)).toEqual([dates[300], dates[301], dates[302]]);
    expect(days[200].ratio).toBeCloseTo(1, 2);
  });

  it('groups spike days and measures the fade, without the spike raising the baseline', () => {
    const [e] = findEpisodes(days);
    expect(e).toMatchObject({ start: dates[300], end: dates[302], peak_date: dates[300], peak_multiple: 4, days_elevated: 3, days_peak_to_normal: 3, ongoing: false });
    expect(days[310].expected).toBeCloseTo(1000 * weekendFactor(dates[310]), -1);
  });
});

describe('analyzeTraffic', () => {
  const site = dates.map((d) => ({ date: d, visits: visitsOn(d), pageviews: visitsOn(d) * 2, web_clicks: 300, news_clicks: SPIKE[d] ? 500 : 10, discover_clicks: 0, ref_search: 400, ref_social: 50, ref_direct: 300, ref_websites: 50 }));
  const viral = { url: 'https://altwire.net/viral-news/', title: 'Band announces reunion', published_at: `${dates[300]}T14:00:00Z`, categories: ['News'] };
  const evergreen = { url: 'https://altwire.net/old-review/', title: 'Old synth review', published_at: '2019-05-01T14:00:00Z', categories: ['Reviews'] };
  const pages = dates.flatMap((d, i) => [
    { date: d, url_key: 'altwire.net/old-review', pageviews: 100, web_clicks: 40 },
    { date: d, url_key: 'altwire.net', pageviews: 300, web_clicks: 5 },
    ...(i >= 300 ? [{ date: d, url_key: 'altwire.net/viral-news', pageviews: SPIKE[d] ? 3000 : 50, web_clicks: SPIKE[d] ? 200 : 2 }] : []),
  ]);
  const report = analyzeTraffic({ site, pages, posts: [viral, evergreen], today: TODAY });

  it('describes a normal day and the latest day', () => {
    expect(report.window).toMatchObject({ start: addDays(TODAY, -365), end: dates.at(-1) });
    expect(report.normal_day.visits_now).toBeGreaterThan(900);
    expect(report.normal_day.by_weekday_pct.Saturday).toBeLessThan(report.normal_day.by_weekday_pct.Monday);
    expect(report.latest_day).toMatchObject({ date: dates.at(-1), spike: false });
  });

  it('finds the spike, its driver, and the source that rose', () => {
    expect(report.spikes.count).toBe(1);
    const [spike] = report.spikes.biggest;
    expect(spike.drivers[0]).toMatchObject({ title: 'Band announces reunion', kind: 'news', fresh: true, age_days: 0 });
    expect(spike.main_google_source).toBe('google_news');
    expect(report.spikes.led_by_article_under_7_days_old_pct).toBe(100);
    expect(report.spikes.typical).toEqual({ peak_multiple: 4, days_elevated: 3, days_peak_to_normal: 3 });
  });

  it('splits traffic by article age and measures the back catalog', () => {
    const all = report.pageviews_by_article_age_pct.all_days;
    expect(all.archive).toBeGreaterThan(all.fresh);
    expect(report.pageviews_by_article_age_pct.spike_days.fresh).toBeGreaterThan(report.pageviews_by_article_age_pct.normal_days.fresh);
    // The viral article is too new to count as back catalog for the last 90 days.
    expect(report.back_catalog).toMatchObject({ articles_older_than_30_days: 1, with_any_google_click: 1, from_articles_over_a_year_old_pct: 100 });
    expect(report.back_catalog.top_earners[0].title).toBe('Old synth review');
  });

  it('measures how fast an article fades', () => {
    const lifecycle = report.article_lifecycle.all;
    expect(lifecycle.articles).toBe(1);
    // 3,000 views on each of its first 3 days, then 50 a day: half the first month by day 2.
    expect(lifecycle.median_days_to_half_of_first_month).toBe(2);
    expect(lifecycle.median_first_2_days_share_pct).toBeGreaterThan(50);
    expect(lifecycle.google_click_within_3_days_pct).toBe(100);
  });

  it('summarizes for the digest', () => {
    const s = summarizePatterns(report);
    expect(s).toMatchObject({ typical_spike: { days_peak_to_normal: 3 }, current_spike_drivers: [] });
    expect(analyzeTraffic({ site: site.slice(0, 5), pages: [], posts: [], today: TODAY })).toEqual({ error: 'Not enough daily traffic data yet' });
  });
});
