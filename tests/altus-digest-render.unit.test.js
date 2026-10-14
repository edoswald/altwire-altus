import { describe, expect, it, vi } from 'vitest';

vi.mock('../handlers/altus-digest.js', () => ({ getAltwireMorningDigest: vi.fn() }));
vi.mock('../lib/ses-client.js', () => ({ sendEmail: vi.fn() }));
vi.mock('../lib/altus-db.js', () => ({ readAgentMemory: vi.fn(), writeAgentMemory: vi.fn() }));
vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { buildDigestHtml, buildDigestSections, buildDigestText } = await import('../handlers/altus-digest-mailer.js');

const digest = {
  date: '2026-10-14',
  analytics: {
    days: 7,
    windows: { gsc: { current: ['2026-10-05', '2026-10-11'] } },
    traffic: {
      nb_visits: { current: 2100, previous: 2000, change_pct: 5 },
      nb_pageviews: { current: 4000, previous: 4400, change_pct: -9.1 },
      bounce_rate: { current: '52%', previous: '50%', change_pct: null },
    },
    yesterday_vs_last_week: { nb_visits: { current: 320, previous: 290, change_pct: 10.3 } },
    top_pages: [{ url: 'https://altwire.net/top-story/', label: 'top-story', pageviews: 800 }],
    page_movers: { risers: [{ key: 'https://altwire.net/riser', label: 'riser', current: 600, previous: 100, change: 500 }], fallers: [] },
    search: {
      totals: { clicks: { current: 300, previous: 250, change_pct: 20 }, position: { current: 18.24, previous: 19 } },
      query_movers: { risers: [], fallers: [{ key: 'band <tour>', current: 3, previous: 40, change: -37 }] },
      page_movers: null,
    },
    opportunity_zone_new: [{ query: 'new album', page: 'https://altwire.net/x/', impressions: 1200, position: 12.3 }],
    google_news: { total_clicks: 0, total_impressions: 0, top_pages: [] },
    recent_articles: [{ title: 'Fresh Review', pageviews: 450, search_clicks: 9, avg_position: 14.2 }],
  },
  news_alerts: { watch_list_matches: [{ name: 'Some Band', query: 'some band tour', source: 'google_news' }] },
  story_opportunities: { count: 2, top: [{ topic: 'Festival preview', impressions: 5000, position: 8.4, coverage_status: 'no_coverage' }] },
  warnings: [{ section: 'analytics_gsc_news', message: 'gsc_api_error' }],
};

describe('digest rendering', () => {
  it('leads with the numbers and includes the analytics sections in order', () => {
    const titles = buildDigestSections(digest).map((s) => s.title);
    expect(titles[0]).toBe('THE NUMBERS');
    expect(titles).toEqual(expect.arrayContaining([
      'TRAFFIC MOVERS (7d vs prior 7d)', 'SEARCH MOVERS', 'NEW IN SEARCH POSITIONS 5–30', 'GOOGLE NEWS',
      'RECENT ARTICLES (last 14 days)', 'TOP ARTICLES THIS WEEK', 'WATCH LIST & NEWS ALERTS', 'STORY OPPORTUNITIES', 'DATA WARNINGS',
    ]));
  });

  it('drops uptime, incidents, reviews, loaners, AI costs, and action items', () => {
    const text = buildDigestText({ ...digest, uptime: { site: { status: 'down' } }, ai_costs: { monthly_total: 5 }, overdue_loaners: { count: 1, loaners: [{}] } });
    for (const gone of ['SITE STATUS', 'INCIDENTS', 'LOANER', 'AI COSTS', 'OPEN ITEMS', 'EDITORIAL PIPELINE']) {
      expect(text).not.toContain(gone);
    }
  });

  it('formats deltas with signs', () => {
    const text = buildDigestText(digest);
    expect(text).toContain('Last 7 days: 2,100 visits (+5.0%) · 4,000 pageviews (−9.1%)');
    expect(text).toContain('Yesterday: 320 visits (+10.3% vs same day last week)');
    expect(text).toContain('300 clicks (+20.0%) · avg position 18.2 (was 19.0)');
    expect(text).toContain('↑ riser — 600 views (+500)');
    expect(text).toContain('• Festival preview — 5,000 impressions, position 8.4, no coverage');
  });

  it('renders flattened watch-list matches without throwing', () => {
    expect(buildDigestText(digest)).toContain('⚡ some band tour [Some Band]');
  });

  it('escapes HTML in data-derived text', () => {
    const html = buildDigestHtml(digest);
    expect(html).toContain('band &lt;tour&gt;');
    expect(html).not.toContain('band <tour>');
  });

  it('labels Google News pages by title, falling back to the decoded path', () => {
    const text = buildDigestText({ ...digest, analytics: { ...digest.analytics, google_news: {
      total_clicks: 7, total_impressions: 31,
      top_pages: [
        { url: 'https://altwire.net/ru/%D0%BB%D0%BE%D1%80%D0%B5/', title: null, clicks: 2, impressions: 5 },
        { url: 'https://altwire.net/x/', title: 'Real Title', clicks: 5, impressions: 26 },
      ],
    } } });
    expect(text).toContain('• ru/лоре — 2 clicks');
    expect(text).toContain('• Real Title — 5 clicks');
  });

  it('renders gracefully with no analytics at all', () => {
    const text = buildDigestText({ date: '2026-10-14' });
    expect(text).toContain('STORY OPPORTUNITIES');
    expect(text).not.toContain('THE NUMBERS');
  });
});
