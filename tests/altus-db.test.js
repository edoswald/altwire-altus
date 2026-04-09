import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('altus-db', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('initSchema resolves without error when DATABASE_URL is set', async () => {
    // Uses a real connection string — skipped in TEST_MODE
    if (process.env.TEST_MODE === 'true' || !process.env.DATABASE_URL) {
      expect(true).toBe(true); // skip
      return;
    }
    const { initSchema } = await import('../lib/altus-db.js');
    await expect(initSchema()).resolves.not.toThrow();
  });

  it('pool is exported as default', async () => {
    const mod = await import('../lib/altus-db.js');
    expect(mod.default).toBeDefined();
  });

  it('upsertContent returns inserted row id', async () => {
    if (process.env.TEST_MODE === 'true' || !process.env.DATABASE_URL) {
      expect(true).toBe(true); // skip
      return;
    }
    const { upsertContent, initSchema } = await import('../lib/altus-db.js');
    await initSchema();
    const fakeEmbedding = Array(1024).fill(0.1);
    const id = await upsertContent({
      wp_id: 999999,
      content_type: 'post',
      title: 'Test post',
      slug: 'test-post',
      url: 'https://altwire.net/test-post',
      published_at: new Date().toISOString(),
      author: 'tester',
      categories: ['test'],
      tags: ['unit-test'],
      raw_text: 'This is a test post for unit testing.',
      embedding: fakeEmbedding,
    });
    expect(typeof id).toBe('number');
  });
});
