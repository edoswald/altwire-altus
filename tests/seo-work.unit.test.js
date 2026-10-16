import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const query = vi.fn();
vi.mock('../lib/altus-db.js', () => ({ default: { query: (...args) => query(...args) } }));

import {
  auditSeo,
  compareResult,
  estimatedExtraClicks,
  expectedCtr,
  findSeoCandidates,
  summarizeSeoQueue,
} from '../handlers/altus-seo-work.js';

describe('SEO scoring', () => {
  it('uses a falling CTR curve by position', () => {
    expect(expectedCtr(1)).toBeGreaterThan(expectedCtr(5));
    expect(expectedCtr(11.1)).toBe(0.01);
    expect(expectedCtr(40)).toBe(0.004);
    expect(expectedCtr(0)).toBe(0);
  });

  it('estimates the clicks a page misses at its position', () => {
    // 2,000 impressions at #4 (7% typical) but 1% CTR → about 120 clicks missed.
    expect(estimatedExtraClicks({ impressions: 2000, ctr: 0.01, position: 4 })).toBe(120);
    expect(estimatedExtraClicks({ impressions: 2000, ctr: 0.2, position: 4 })).toBe(0);
  });

  it('flags missing and badly sized fields and low CTR, in plain words', () => {
    const issues = auditSeo({
      seo: { title: '', description: '', focus_keyword: '' },
      rendered: { title: 'Arturia MicroFreak Review: A Weird, Wonderful Hybrid Synth For Under $400' },
      search: { impressions: 1955, ctr: 0.003, position: 11.1 },
    });
    expect(issues.map((i) => i.code)).toEqual(['missing_description', 'title_too_long', 'low_ctr', 'no_focus_keyword']);
    expect(issues.find((i) => i.code === 'low_ctr').detail).toBe('Clicked 0.3% of the time at position #11.1; around 1% is typical.');
    expect(auditSeo({
      seo: { description: 'x'.repeat(120), focus_keyword: 'k' },
      rendered: { title: 'A good title of fine length' },
      search: { impressions: 500, ctr: 0.08, position: 3 },
    })).toEqual([]);
  });

  it('compares the 28 days after a change with the baseline', () => {
    const better = compareResult(
      { search: { clicks: 20, impressions: 2000, position: 9.8 } },
      { search: { clicks: 45, impressions: 2100, position: 9.1 } },
    );
    expect(better).toEqual({
      clicks: { before: 20, after: 45, change_pct: 125 },
      impressions: { before: 2000, after: 2100, change_pct: 5 },
      ctr_pct: { before: 1, after: 2.1 },
      position: { before: 9.8, after: 9.1 },
      verdict: 'improved',
    });
    expect(compareResult({ search: { clicks: 3, impressions: 100 } }, { search: { clicks: 5, impressions: 100 } }).verdict).toBe('no_clear_change');
    expect(compareResult({ search: { clicks: 40, impressions: 1000 } }, { search: { clicks: 20, impressions: 1000 } }).verdict).toBe('declined');
    expect(compareResult(null, { search: {} })).toBeNull();
  });
});

describe('findSeoCandidates', () => {
  beforeEach(() => query.mockReset());

  it('joins Search Console pages with articles and SEO fields and ranks by clicks to gain', async () => {
    query.mockImplementation(async (sql) => {
      if (/FROM altus_content/.test(sql)) {
        return { rows: [
          { wp_id: 4, title: 'MicroFreak', url: 'https://altwire.net/review-microfreak/', published_at: '2025-07-01' },
          { wp_id: 6, title: 'Smpltrek', url: 'https://altwire.net/sonicware-smpltrek/', published_at: '2025-03-01' },
          { wp_id: 7, title: 'Fine', url: 'https://altwire.net/fine/', published_at: '2024-01-01' },
          { wp_id: 8, title: 'Changed', url: 'https://altwire.net/changed/', published_at: '2024-01-01' },
        ] };
      }
      if (/FROM altus_seo_changes/.test(sql)) return { rows: [{ url_key: 'https://altwire.net/changed', changed_at: '2026-10-01' }] };
      return { rows: [] };
    });
    const page = (url, impressions, clicks, position) => ({ keys: [url], impressions, clicks, ctr: clicks / impressions, position });
    const deps = {
      gsc: vi.fn(async () => ({ rows: [
        page('https://altwire.net/review-microfreak/', 1955, 6, 11.1),
        page('https://altwire.net/sonicware-smpltrek/', 1240, 9, 4.2),
        page('https://altwire.net/fine/', 800, 70, 3),
        page('https://altwire.net/changed/', 5000, 5, 5),
        page('https://altwire.net/de/review-microfreak/', 900, 1, 8),
        page('https://altwire.net/category/gear/', 700, 1, 9),
      ] })),
      seoBulk: vi.fn(async (ids) => ({
        items: ids.map((id) => ({
          id,
          context: { name: `Post ${id}` },
          seo: id === 7 ? { title: 'Fine title here', description: 'd'.repeat(120), focus_keyword: 'k' } : { title: '', description: '', focus_keyword: '' },
          rendered: { title: id === 7 ? 'A perfectly fine title for this' : `Post ${id}` },
        })),
        missing: [],
      })),
      detail: vi.fn(async () => ({ top_queries: [{ query: 'q', clicks: 1, impressions: 10, position: 5 }] })),
    };

    const result = await findSeoCandidates({ limit: 5, deps });

    expect(deps.seoBulk).toHaveBeenCalledWith([4, 6, 7]);
    expect(result.pages_reviewed).toBe(3);
    expect(result.candidates.map((c) => c.wp_id)).toEqual([6, 4]);
    expect(result.candidates[0]).toMatchObject({
      url: 'https://altwire.net/sonicware-smpltrek/',
      title: 'Post 6',
      search: { clicks: 9, impressions: 1240, ctr: 0.7, position: 4.2 },
      estimated_extra_clicks: 78,
      top_queries: [{ query: 'q', clicks: 1, impressions: 10, position: 5 }],
    });
    expect(result.backlog).toMatchObject({ missing_description: 2, low_ctr: 2 });
  });

  it('reports a Search Console error instead of an empty list', async () => {
    query.mockResolvedValue({ rows: [] });
    const result = await findSeoCandidates({ deps: { gsc: async () => ({ error: 'gsc_api_error', message: 'quota' }) } });
    expect(result).toEqual({ error: 'Search Console: quota' });
  });
});

describe('SEO queue summary for the digest', () => {
  it('counts new items, newest first, in plain words', () => {
    const summary = summarizeSeoQueue([
      { page_url: 'https://altwire.net/a/', query: 'a', reason_code: 'declining_target', source: 'hal', first_seen: '2026-10-10 09:00:00' },
      { page_url: 'https://altwire.net/b/', query: 'b', reason_code: 'ctr_gap', source: null, first_seen: '2026-10-15 14:00:00', notes: 'check title' },
      { page_url: 'https://altwire.net/c/', query: 'c', reason_code: 'something_else', source: '', first_seen: '2026-10-15 07:00:00' },
    ], '2026-10-15', { limit: 2 });
    expect(summary.waiting).toBe(3);
    expect(summary.new_since_yesterday).toBe(2);
    expect(summary.items).toEqual([
      { query: 'b', url: 'https://altwire.net/b/', reason: 'seen but rarely clicked', queued_by: 'person', queued_on: '2026-10-15 14:00:00', notes: 'check title' },
      { query: 'c', url: 'https://altwire.net/c/', reason: 'something_else', queued_by: 'person', queued_on: '2026-10-15 07:00:00', notes: null },
    ]);
    expect(summarizeSeoQueue([{ reason_code: 'declining_target', source: 'hal' }], '2026-10-15').items[0]).toMatchObject({ reason: 'slipping in Google', queued_by: 'agent' });
    expect(summarizeSeoQueue(undefined, '2026-10-15')).toEqual({ waiting: 0, new_since_yesterday: 0, items: [] });
  });
});
