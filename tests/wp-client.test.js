import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('wp-client.js', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it('buildAuthHeader base64-encodes user:password with spaces preserved', async () => {
    process.env.ALTWIRE_WP_USER = 'admin';
    process.env.ALTWIRE_WP_APP_PASSWORD = 'xxxx xxxx xxxx xxxx xxxx xxxx';
    const { buildAuthHeader } = await import('../lib/wp-client.js');
    const header = buildAuthHeader();
    const decoded = Buffer.from(header.replace('Basic ', ''), 'base64').toString('utf8');
    expect(decoded).toBe('admin:xxxx xxxx xxxx xxxx xxxx xxxx');
    delete process.env.ALTWIRE_WP_USER;
    delete process.env.ALTWIRE_WP_APP_PASSWORD;
  });

  it('stripHtml removes all HTML tags from a string', async () => {
    const { stripHtml } = await import('../lib/wp-client.js');
    expect(stripHtml('<p>Hello <strong>world</strong></p>')).toBe('Hello world');
    expect(stripHtml('No tags here')).toBe('No tags here');
    // stripHtml only strips tags — entity decoding is handled by decodeHtmlEntities
    expect(stripHtml('&amp; &lt; &gt; &nbsp;')).toBe('&amp; &lt; &gt; &nbsp;');
  });

  it('fetchPosts paginates until response shorter than per_page', async () => {
    process.env.ALTWIRE_WP_URL = 'https://altwire.net';
    process.env.ALTWIRE_WP_USER = 'admin';
    process.env.ALTWIRE_WP_APP_PASSWORD = 'pass';

    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation((url) => {
      callCount++;
      const items = callCount === 1
        ? Array(100).fill(null).map((_, i) => ({
            id: i + 1, slug: `post-${i}`, link: `https://altwire.net/post-${i}`,
            date: '2024-01-01T00:00:00', title: { rendered: `Post ${i}` },
            content: { rendered: '<p>Content</p>' }, excerpt: { rendered: '<p>Excerpt</p>' },
            categories: [], tags: [],
          }))
        : Array(5).fill(null).map((_, i) => ({
            id: i + 101, slug: `post-${i+100}`, link: `https://altwire.net/post-${i+100}`,
            date: '2024-01-01T00:00:00', title: { rendered: `Post ${i+100}` },
            content: { rendered: '<p>Content</p>' }, excerpt: { rendered: '<p>Excerpt</p>' },
            categories: [], tags: [],
          }));
      return Promise.resolve({ ok: true, json: async () => items });
    });
    vi.stubGlobal('fetch', mockFetch);

    const { fetchPosts } = await import('../lib/wp-client.js');
    const posts = await fetchPosts({ categoryCache: new Map(), tagCache: new Map() });
    expect(posts).toHaveLength(105);
    expect(callCount).toBe(2);

    delete process.env.ALTWIRE_WP_URL;
    delete process.env.ALTWIRE_WP_USER;
    delete process.env.ALTWIRE_WP_APP_PASSWORD;
  });

  it('fetchGalleries paginates until response shorter than per_page', async () => {
    process.env.ALTWIRE_WP_URL = 'https://altwire.net';
    process.env.ALTWIRE_WP_USER = 'admin';
    process.env.ALTWIRE_WP_APP_PASSWORD = 'pass';

    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++;
      const items = callCount === 1
        ? Array(50).fill(null).map((_, i) => ({
            id: i + 1, title: `Gallery ${i}`, description: '', slug: `gallery-${i}`,
            url: '', image_count: 5, images: [],
          }))
        : Array(3).fill(null).map((_, i) => ({
            id: i + 51, title: `Gallery ${i+50}`, description: '', slug: `gallery-${i+50}`,
            url: '', image_count: 2, images: [],
          }));
      return Promise.resolve({ ok: true, json: async () => items });
    });
    vi.stubGlobal('fetch', mockFetch);

    const { fetchGalleries } = await import('../lib/wp-client.js');
    const galleries = await fetchGalleries();
    expect(galleries).toHaveLength(53);
    expect(callCount).toBe(2);

    delete process.env.ALTWIRE_WP_URL;
    delete process.env.ALTWIRE_WP_USER;
    delete process.env.ALTWIRE_WP_APP_PASSWORD;
  });
});
