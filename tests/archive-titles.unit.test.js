import { describe, expect, it, vi } from 'vitest';

const query = vi.fn();
vi.mock('../lib/altus-db.js', () => ({ default: { query } }));

const { annotatePagesWithTitles } = await import('../lib/archive-titles.js');

describe('annotatePagesWithTitles', () => {
  it('adds published titles and flags listing pages', async () => {
    query.mockResolvedValueOnce({ rows: [{ url: 'https://altwire.net/i-am-choir', title: 'I AM CHOIR (2026): A Vocal Enhancement Plugin' }] });
    const rows = await annotatePagesWithTitles([
      { url: 'https://altwire.net/i-am-choir/', label: 'i-am-choir', nb_hits: 10 },
      { url: 'https://altwire.net/news/', label: 'news', nb_hits: 51 },
    ]);
    expect(query.mock.calls[0][1]).toEqual([['https://altwire.net/i-am-choir', 'https://altwire.net/news']]);
    expect(rows).toEqual([
      { url: 'https://altwire.net/i-am-choir/', label: 'i-am-choir', nb_hits: 10, title: 'I AM CHOIR (2026): A Vocal Enhancement Plugin', is_article: true },
      { url: 'https://altwire.net/news/', label: 'news', nb_hits: 51, title: null, is_article: false },
    ]);
  });

  it('returns rows unchanged when the archive lookup fails', async () => {
    query.mockRejectedValueOnce(new Error('db down'));
    const pages = [{ url: 'https://altwire.net/x/' }];
    expect(await annotatePagesWithTitles(pages)).toBe(pages);
  });
});
