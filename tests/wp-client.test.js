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

  it('buildAgentTokenHeader prefers scoped tokens and falls back to generic token', async () => {
    process.env.ALTWIRE_WP_AGENT_TOKEN = 'generic-token';
    process.env.ALTWIRE_WP_AGENT_READ_TOKEN = 'read-token';
    process.env.ALTWIRE_WP_AGENT_WRITE_TOKEN = 'write-token';
    const { buildAgentTokenHeader } = await import('../lib/wp-client.js');
    expect(buildAgentTokenHeader('read')).toBe('read-token');
    expect(buildAgentTokenHeader('write')).toBe('write-token');

    delete process.env.ALTWIRE_WP_AGENT_READ_TOKEN;
    delete process.env.ALTWIRE_WP_AGENT_WRITE_TOKEN;
    expect(buildAgentTokenHeader('read')).toBe('generic-token');
    expect(buildAgentTokenHeader('write')).toBe('generic-token');

    delete process.env.ALTWIRE_WP_AGENT_TOKEN;
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
      return Promise.resolve({
        ok: true,
        headers: { get: () => '1' },
        json: async () => items,
      });
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

  it('fetchPosts adds after + modified_after when afterDate is provided', async () => {
    process.env.ALTWIRE_WP_URL = 'https://altwire.net';
    process.env.ALTWIRE_WP_USER = 'admin';
    process.env.ALTWIRE_WP_APP_PASSWORD = 'pass';

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => '1' },
      json: async () => [{
        id: 1, slug: 'post', link: 'https://altwire.net/post',
        date: '2024-01-01T00:00:00', title: { rendered: 'Post' },
        content: { rendered: '<p>Content</p>' }, excerpt: { rendered: '<p>Excerpt</p>' },
        categories: [], tags: [],
      }],
    });
    vi.stubGlobal('fetch', mockFetch);

    const { fetchPosts } = await import('../lib/wp-client.js');
    await fetchPosts({ categoryCache: new Map(), tagCache: new Map() }, '2024-01-01T00:00:00.000Z');

    const url = mockFetch.mock.calls[0][0];
    expect(url).toContain('after=2024-01-01T00%3A00%3A00.000Z');
    expect(url).toContain('modified_after=2024-01-01T00%3A00%3A00.000Z');

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
      return Promise.resolve({
        ok: true,
        headers: { get: () => '1' },
        json: async () => items,
      });
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

  it('getSeoState calls the cirrusly-seo endpoint with X-Agent-Token auth', async () => {
    process.env.ALTWIRE_WP_URL = 'https://altwire.net';
    process.env.ALTWIRE_WP_AGENT_READ_TOKEN = 'read-token';

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({ object: { type: 'post', id: 99 }, score: { mode: 'editorial', score: 88 } }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const { getSeoState } = await import('../lib/wp-client.js');
    const result = await getSeoState({ objectType: 'post', objectId: 99 });

    expect(result.object.id).toBe(99);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://altwire.net/wp-json/cirrusly/v1/seo/state?object_type=post&object_id=99',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          'X-Agent-Token': 'read-token',
        }),
      })
    );

    delete process.env.ALTWIRE_WP_URL;
    delete process.env.ALTWIRE_WP_AGENT_READ_TOKEN;
  });

  it('updateSeoFields posts fields to the cirrusly-seo endpoint with write token auth', async () => {
    process.env.ALTWIRE_WP_URL = 'https://altwire.net';
    process.env.ALTWIRE_WP_AGENT_WRITE_TOKEN = 'write-token';

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({ changed_fields: ['seo_title'] }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const { updateSeoFields } = await import('../lib/wp-client.js');
    const result = await updateSeoFields({
      objectType: 'post',
      objectId: 55,
      fields: { seo_title: 'Updated Title' },
      reason: 'Improve CTR for a high-impression query',
    });

    expect(result.changed_fields).toEqual(['seo_title']);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://altwire.net/wp-json/cirrusly/v1/seo/update-fields',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'X-Agent-Token': 'write-token',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({
          object_type: 'post',
          object_id: 55,
          fields: { seo_title: 'Updated Title' },
          reason: 'Improve CTR for a high-impression query',
        }),
      })
    );

    delete process.env.ALTWIRE_WP_URL;
    delete process.env.ALTWIRE_WP_AGENT_WRITE_TOKEN;
  });

  it('pluginFetch preserves plugin-style error payloads for SEO actions', async () => {
    process.env.ALTWIRE_WP_URL = 'https://altwire.net';
    process.env.ALTWIRE_WP_AGENT_WRITE_TOKEN = 'write-token';

    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      headers: { get: () => 'application/json' },
      json: async () => ({
        code: 'cirrusly_seo_hal_disabled',
        message: 'Hal integration is not enabled for this site.',
        data: { status: 403 },
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const { updateSeoFields } = await import('../lib/wp-client.js');

    await expect(updateSeoFields({
      objectType: 'post',
      objectId: 55,
      fields: { seo_title: 'Updated Title' },
      reason: 'Test',
    })).rejects.toMatchObject({
      message: 'WP plugin fetch failed: 403 Hal integration is not enabled for this site.',
      status: 403,
      code: 'cirrusly_seo_hal_disabled',
      details: { status: 403 },
    });

    delete process.env.ALTWIRE_WP_URL;
    delete process.env.ALTWIRE_WP_AGENT_WRITE_TOKEN;
  });
});
