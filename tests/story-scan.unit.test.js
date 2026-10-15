import { describe, expect, it, vi } from 'vitest';

vi.mock('../logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import {
  bestRowPerQuery,
  classifyCoverage,
  describeOpportunity,
  positionProximity,
  previousByQuery,
} from '../handlers/altus-story-scan.js';

const row = (query, page, impressions, position, clicks = 1) => ({ keys: [query, page], impressions, position, clicks });

describe('story scan helpers', () => {
  it('scores closeness to the top, clamped to positions 5-30', () => {
    expect(positionProximity(5)).toBe(1);
    expect(positionProximity(3)).toBe(1);
    expect(positionProximity(17.5)).toBeCloseTo(0.5);
    expect(positionProximity(40)).toBe(0);
  });

  it('keeps one row per query (most impressions), dropping translated pages, the brand, and out-of-zone rows', () => {
    const rows = bestRowPerQuery([
      row('Arturia MicroFreak', 'https://altwire.net/review-microfreak/', 2081, 11.1),
      row('arturia microfreak', 'https://altwire.net/synth-roundup/', 300, 14),
      row('microfreak test', 'https://altwire.net/de/review-microfreak/', 900, 9),
      row('altwire reviews', 'https://altwire.net/', 500, 6),
      row('woovebox', 'https://altwire.net/woovebox/', 488, 3),
    ]);
    expect(rows).toEqual([
      { key: 'arturia microfreak', query: 'Arturia MicroFreak', page: 'https://altwire.net/review-microfreak/', impressions: 2081, clicks: 1, position: 11.1 },
    ]);
  });

  it('sums previous-window impressions per query and keeps the best position', () => {
    const prev = previousByQuery([row('A', 'p1', 100, 12), row('a', 'p2', 50, 9)]);
    expect(prev.get('a')).toEqual({ impressions: 150, position: 9 });
  });

  it('classifies coverage from reranker relevance, and never assumes a gap when search failed', () => {
    const hit = (relevance) => ({ ranking: 'reranked', results: [{ title: 'T', url: 'u', published_at: '2020-01-01', relevance }] });
    expect(classifyCoverage(hit(0.82))).toMatchObject({ status: 'dedicated', multiplier: 1.0 });
    expect(classifyCoverage(hit(0.5))).toMatchObject({ status: 'partial', multiplier: 1.25 });
    expect(classifyCoverage(hit(0.1))).toMatchObject({ status: 'none', multiplier: 1.5 });
    expect(classifyCoverage({ ranking: 'reranked', results: [] })).toMatchObject({ status: 'none' });
    expect(classifyCoverage({ error: 'Voyage down' })).toMatchObject({ status: 'unknown', multiplier: 1.0, best: null });
    expect(classifyCoverage({ ranking: 'fused', results: [{ title: 'T', url: 'u' }] })).toMatchObject({ status: 'unknown' });
  });

  it('suggests refresh for old dedicated coverage and writes a plain reason', () => {
    const now = Date.parse('2026-10-15T00:00:00Z');
    const base = {
      query: 'arturia microfreak', impressions: 2081, position: 11.1, prev_position: 14.3, prev_impressions: 1200,
      page_url: 'https://altwire.net/review-microfreak/',
    };
    const refresh = describeOpportunity({ ...base, coverage_status: 'dedicated', best_match: { url: 'https://altwire.net/review-microfreak', title: 'Review: MicroFreak', published_at: '2023-04-01' } }, now);
    expect(refresh.suggestion).toBe('refresh');
    expect(refresh.reason).toBe('#11.1 for "arturia microfreak"; 2,081 impressions in 28 days; up from #14.3; impressions +73%; the ranking page covers it (published 42 months ago)');

    const fresh = describeOpportunity({ ...base, prev_position: null, prev_impressions: null, coverage_status: 'none', best_match: null }, now);
    expect(fresh).toEqual({ suggestion: 'new_story', reason: '#11.1 for "arturia microfreak"; 2,081 impressions in 28 days; new this window; no dedicated AltWire piece' });

    expect(describeOpportunity({ ...base, coverage_status: 'partial', best_match: { title: 'Synth roundup' } }, now).suggestion).toBe('expand');
    expect(describeOpportunity({ ...base, coverage_status: 'unknown', best_match: null }, now).suggestion).toBe('check_coverage');
  });
});

describe('getOpportunityZoneQueries request', () => {
  it('sends no query filter (notContains "" matches nothing) and pulls a deep pool', async () => {
    vi.resetModules();
    const query = vi.fn(async () => ({ data: { rows: [
      { keys: ['a', 'p1'], clicks: 9, impressions: 50, position: 2 },
      { keys: ['b', 'p2'], clicks: 1, impressions: 80, position: 12 },
      { keys: ['c', 'p3'], clicks: 2, impressions: 300, position: 7 },
    ] } }));
    vi.doMock('googleapis', () => ({ google: {
      auth: { GoogleAuth: class {} },
      searchconsole: () => ({ searchanalytics: { query } }),
    } }));
    process.env.ALTWIRE_GSC_SERVICE_ACCOUNT_JSON ??= JSON.stringify({ client_email: 'x@y', private_key: 'k' });
    process.env.ALTWIRE_GSC_SITE_URL ??= 'sc-domain:altwire.net';
    const { getOpportunityZoneQueries } = await import('../handlers/altwire-gsc-client.js');
    const result = await getOpportunityZoneQueries('2026-09-14', '2026-10-12', { limit: 1 });
    const body = query.mock.calls[0][0].requestBody;
    expect(body.dimensionFilterGroups).toBeUndefined();
    expect(body.rowLimit).toBeGreaterThanOrEqual(5000);
    expect(result.rows.map((r) => r.keys[0])).toEqual(['c']);
  });
});
