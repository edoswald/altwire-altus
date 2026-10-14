import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/altus-db.js', () => ({ default: { query: vi.fn() }, hasDbConfig: () => false }));
vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { buildCrossReference } = await import('../handlers/altus-combined-analytics.js');

describe('buildCrossReference', () => {
  it('joins Matomo and GSC rows regardless of trailing slash or case', () => {
    const rows = buildCrossReference(
      [{ url: 'https://altwire.net/orb-mk1-review/', title: 'ORB MK1', pageviews: 176 }],
      [{ keys: ['https://AltWire.net/orb-mk1-review'], impressions: 2589, clicks: 107, position: 4.8, ctr: 0.04 }],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ pageviews: 176, impressions: 2589, clicks: 107 });
  });

  it('marks GSC pages missing from the Matomo list as unknown pageviews, not zero', () => {
    const rows = buildCrossReference([], [{ keys: ['https://altwire.net/microfreak-review/'], impressions: 5291, clicks: 26 }]);
    expect(rows[0].pageviews).toBeNull();
    expect(rows[0].combined_score).toBeCloseTo(529.1);
  });
});

describe('getTopArticles', () => {
  it('asks Matomo for more than its 100-row default', async () => {
    vi.stubEnv('ALTWIRE_MATOMO_URL', 'https://matomo.example');
    vi.stubEnv('ALTWIRE_MATOMO_TOKEN_AUTH', 't');
    vi.stubEnv('ALTWIRE_MATOMO_SITE_ID', '1');
    const bodies = [];
    vi.stubGlobal('fetch', async (_url, init) => {
      bodies.push(new URLSearchParams(init.body));
      return { ok: true, json: async () => [{ label: 'a-review', nb_hits: 3 }] };
    });
    const { getTopArticles } = await import('../handlers/altwire-matomo-client.js');
    await getTopArticles('range', '2026-09-01,2026-09-28', 500);
    await getTopArticles('day', 'yesterday', 20);
    expect(bodies.map((b) => b.get('filter_limit'))).toEqual(['1000', '100']);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
});
