import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/altus-db.js', () => ({
  upsertContent: vi.fn(),
  logIngestRun: vi.fn(),
}));

vi.mock('../lib/wp-client.js', () => ({
  fetchAllPosts: vi.fn(),
  fetchAllGalleries: vi.fn(),
}));

vi.mock('../lib/voyage.js', () => ({
  embedDocuments: vi.fn(),
}));

vi.mock('../lib/synthesizer.js', () => ({
  synthesizeGallery: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { fetchAllPosts, fetchAllGalleries } from '../lib/wp-client.js';
import { reIngestHandler } from '../handlers/altus-reingest.js';

describe('reIngestHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DATABASE_URL = 'postgres://test';
  });

  it('filters recent gallery runs to recently changed galleries instead of full ingest counts', async () => {
    fetchAllPosts.mockResolvedValue([]);
    fetchAllGalleries.mockResolvedValue([
      { id: 1, title: 'Fresh', modified_at: new Date().toISOString() },
      { id: 2, title: 'Old', modified_at: '2024-01-01T00:00:00.000Z' },
    ]);

    const result = await reIngestHandler({ mode: 'recent', dry_run: true });

    expect(result.success).toBe(true);
    expect(result.galleries_processed).toBe(1);
  });
});
