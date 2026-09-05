import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/altus-db.js', () => ({
  hasDbConfig: vi.fn(() => true),
  upsertContent: vi.fn(),
  logIngestRun: vi.fn(),
  getIndexedGalleryIds: vi.fn(async () => [99, 100]), // galleries already in the archive
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
  hasSynthesizableMaterial: vi.fn(() => true),
  buildGallerySynthesisRequest: vi.fn(() => ({ model: 'test', messages: [] })),
}));

vi.mock('../batch-client.js', () => ({
  submitBatch: vi.fn(),
  waitForBatch: vi.fn(),
  logBatchUsage: vi.fn(),
  collectBatch: vi.fn(),
  isRefusal: vi.fn(),
  extractText: vi.fn(),
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

  it('includes timestamp-less galleries only when they are new to the archive', async () => {
    fetchAllPosts.mockResolvedValue([]);
    fetchAllGalleries.mockResolvedValue([
      { id: 1, title: 'No timestamp — brand new' },
      { id: 99, title: 'No timestamp — already indexed' },
    ]);

    const result = await reIngestHandler({ mode: 'recent', dry_run: true });

    // id 99 is already indexed (mocked getIndexedGalleryIds), id 1 is fresh
    expect(result.success).toBe(true);
    expect(result.galleries_processed).toBe(1);
  });

  it('full mode processes every gallery regardless of timestamps or index state', async () => {
    fetchAllPosts.mockResolvedValue([]);
    fetchAllGalleries.mockResolvedValue([
      { id: 1, title: 'A' },
      { id: 99, title: 'B' },
    ]);

    const result = await reIngestHandler({ mode: 'full', dry_run: true });

    expect(result.galleries_processed).toBe(2);
  });

  it('passes batch_synthesis through to the pipeline and echoes it in the result', async () => {
    fetchAllPosts.mockResolvedValue([]);
    fetchAllGalleries.mockResolvedValue([]);

    const result = await reIngestHandler({ mode: 'full', dry_run: true, batch_synthesis: true });

    expect(result.batch_synthesis).toBe(true);
    expect(result.galleries_ingested).toBe(0);
  });
});
